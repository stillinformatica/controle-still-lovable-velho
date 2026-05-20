import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============================================================
// CONFIGURAÇÃO DO PROXY DE IP FIXO
// Adicione estas variáveis de ambiente no painel do Supabase:
//   PROXY_URL      → ex: http://12.34.56.78:8080
//   PROXY_USERNAME → seu usuário do proxy (opcional)
//   PROXY_PASSWORD → sua senha do proxy (opcional)
// ============================================================
function createProxyClient(): Deno.HttpClient | undefined {
  const proxyUrl = Deno.env.get("PROXY_URL");
  if (!proxyUrl) {
    console.warn("[Proxy] PROXY_URL não configurada. Usando IP dinâmico do Supabase.");
    return undefined;
  }

  const username = Deno.env.get("PROXY_USERNAME");
  const password = Deno.env.get("PROXY_PASSWORD");

  console.log(`[Proxy] Usando proxy: ${proxyUrl}`);

  if (username && password) {
    return Deno.createHttpClient({
      proxy: {
        url: proxyUrl,
        basicAuth: { username, password },
      },
    });
  }

  return Deno.createHttpClient({
    proxy: { url: proxyUrl },
  });
}

// Cliente HTTP global com proxy (reutilizado em todas as requisições)
const httpClient = createProxyClient();

// Wrapper para fetch que usa o cliente com proxy quando disponível
async function proxiedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (httpClient) {
    // deno-lint-ignore no-explicit-any
    return await fetch(url, { ...options, client: httpClient } as any);
  }
  return await fetch(url, options);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (userError || !user) throw new Error("User not authenticated");

    const { data: creds, error: credsError } = await supabaseClient
      .from("shopee_credentials")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (credsError || !creds) throw new Error("Shopee credentials not found");

    let accessToken = creds.access_token;

    const isTokenExpired =
      creds.token_expires_at && new Date(creds.token_expires_at) < new Date();

    if ((!accessToken || isTokenExpired) && creds.auth_code) {
      console.log(
        isTokenExpired
          ? "Token expired, refreshing..."
          : "No access token, exchanging auth code..."
      );
      try {
        const tokenData = await exchangeAuthCode(creds);

        await supabaseClient
          .from("shopee_credentials")
          .update({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires_at: new Date(
              Date.now() + tokenData.expire_in * 1000
            ).toISOString(),
            shop_id: (
              tokenData.shop_id ||
              (tokenData.shop_id_list && tokenData.shop_id_list[0]) ||
              creds.shop_id
            ).toString(),
            auth_code: null,
          })
          .eq("user_id", user.id);

        accessToken = tokenData.access_token;
      } catch (err) {
        console.error("Token exchange failed:", err);
        throw new Error(
          `Falha na autenticação com a Shopee: ${err.message}. Tente clicar em CONECTAR novamente.`
        );
      }
    } else if ((!accessToken || isTokenExpired) && creds.refresh_token) {
      console.log("Token expired and we have refresh_token...");
    }

    if (!accessToken)
      throw new Error("Authorization required. Please connect your shop again.");

    const orders = await fetchShopeeOrders(creds, accessToken);

    // Salva os pedidos no banco
    for (const order of orders) {
      // Evita o erro "Invalid time value" caso create_time não venha na listagem (API v2 da Shopee)
      const createTimeStr = order.create_time 
        ? new Date(order.create_time * 1000).toISOString() 
        : new Date().toISOString();

      const { error: orderErr } = await supabaseClient
        .from("shopee_orders")
        .upsert(
          {
            user_id: user.id,
            shopee_order_sn: order.order_sn,
            order_status: order.order_status,
            customer_name: "Cliente Shopee",
            total_amount: order.total_amount !== undefined ? order.total_amount : 0,
            create_time: createTimeStr,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "shopee_order_sn" }
        );

      if (orderErr) console.error("Error upserting order:", orderErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `${orders.length} pedidos reais sincronizados.`,
        count: orders.length,
        proxy_active: !!httpClient,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

async function exchangeAuthCode(creds: any) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/token/get";

  const SHOPEE_API_URL = "https://partner.shopeemobile.com";
  const REDIRECT_URL = "https://controle-still.lovable.app";

  const body = {
    code: creds.auth_code,
    partner_id: parseInt(creds.partner_id),
    shop_id: parseInt(creds.shop_id),
    redirect_url: REDIRECT_URL,
  };

  const sign = await generateSign(
    creds.partner_key,
    creds.partner_id,
    path,
    timestamp
  );
  const url = `${SHOPEE_API_URL}${path}?partner_id=${creds.partner_id}&timestamp=${timestamp}&sign=${sign}`;

  console.log(`[exchangeAuthCode] Requesting via proxy: ${url}`);
  console.log(`[exchangeAuthCode] Body: ${JSON.stringify(body)}`);

  try {
    const res = await proxiedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    console.log(`[exchangeAuthCode] Raw response: ${text}`);

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `Invalid JSON response from Shopee: ${text.substring(0, 100)}`
      );
    }

    if (data.error) {
      console.error("[exchangeAuthCode] Shopee API Error response:", data);
      throw new Error(
        `Shopee API Error: ${data.message || data.error} (request_id: ${data.request_id})`
      );
    }
    return data;
  } catch (err) {
    console.error(`[exchangeAuthCode] Network or Parsing Error: ${err.message}`);
    throw err;
  }
}

async function fetchShopeeOrders(creds: any, accessToken: string) {
  const SHOPEE_API_URL = "https://partner.shopeemobile.com";
  const path = "/api/v2/order/get_order_list";
  const shopId = parseInt(creds.shop_id);
  const timeFrom = Math.floor(Date.now() / 1000) - 15 * 24 * 60 * 60;
  const timeTo = Math.floor(Date.now() / 1000);

  let allOrders: any[] = [];
  let cursor = ""; // cursor vazio (sem aspas) para a primeira página
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && pageCount < 10) { // limite de 10 páginas (500 pedidos)
    pageCount++;
    const timestamp = Math.floor(Date.now() / 1000);

    // Monta os parâmetros — cursor vazio na 1ª página, valor retornado nas demais
    const params = new URLSearchParams({
      access_token: accessToken,
      page_size: "50",
      partner_id: creds.partner_id,
      shop_id: shopId.toString(),
      time_from: timeFrom.toString(),
      time_to: timeTo.toString(),
      time_range_field: "create_time",
      timestamp: timestamp.toString(),
    });

    // Só adiciona cursor se não for vazio (evita o erro "invalid cursor: cursorInt64")
    if (cursor) {
      params.append("cursor", cursor);
    }

    const sign = await generateSign(
      creds.partner_key,
      creds.partner_id,
      path,
      timestamp,
      accessToken,
      shopId
    );
    params.append("sign", sign);

    const url = `${SHOPEE_API_URL}${path}?${params.toString()}`;
    console.log(`[fetchShopeeOrders] Page ${pageCount}, cursor="${cursor}", URL: ${url}`);

    try {
      const res = await proxiedFetch(url);
      const text = await res.text();
      console.log(`[fetchShopeeOrders] Page ${pageCount} raw response: ${text}`);

      let data: any;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error(`[fetchShopeeOrders] Failed to parse JSON: ${text.substring(0, 200)}`);
        throw new Error(`Resposta inválida da API da Shopee. Verifique as credenciais e o IP do proxy.`);
      }

      if (data.error && data.error !== "" && data.error !== "error_none") {
        console.error(`[fetchShopeeOrders] Shopee API error: ${JSON.stringify(data)}`);
        throw new Error(`Shopee API Error: ${data.message || data.error}`);
      }

      const pageOrders = data.response?.order_list || [];
      allOrders = allOrders.concat(pageOrders);

      // Verifica se há mais páginas
      const more = data.response?.more ?? false;
      cursor = data.response?.next_cursor ?? "";
      hasMore = more && !!cursor;

      console.log(`[fetchShopeeOrders] Page ${pageCount}: ${pageOrders.length} pedidos, more=${more}, next_cursor="${cursor}"`);
    } catch (err) {
      console.error(`[fetchShopeeOrders] Request failed on page ${pageCount}: ${err.message}`);
      throw err;
    }
  }

  console.log(`[fetchShopeeOrders] Total: ${allOrders.length} pedidos em ${pageCount} página(s).`);
  return allOrders;
}

async function generateSign(
  partnerKey: string,
  partnerId: string,
  path: string,
  timestamp: number,
  accessToken = "",
  shopId: number | string = ""
) {
  const baseString = accessToken
    ? `${partnerId}${path}${timestamp}${accessToken}${shopId}`
    : `${partnerId}${path}${timestamp}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(partnerKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
