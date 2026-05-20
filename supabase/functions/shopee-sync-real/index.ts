import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============================================================
// CONFIGURAÇÃO DO PROXY DE IP FIXO
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

const httpClient = createProxyClient();

// deno-lint-ignore no-explicit-any
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseClient = createClient(supabaseUrl, supabaseKey);

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

        const expireInSeconds = Number(tokenData.expire_in);
        const expiresAt = !isNaN(expireInSeconds) && expireInSeconds > 0
          ? new Date(Date.now() + expireInSeconds * 1000)
          : new Date(Date.now() + 4 * 60 * 60 * 1000);

        await supabaseClient
          .from("shopee_credentials")
          .update({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires_at: expiresAt.toISOString(),
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
    }

    if (!accessToken)
      throw new Error("Authorization required. Please connect your shop again.");

    // 1. Busca a lista básica de pedidos (obtenção de IDs)
    console.log("Iniciando busca da lista básica de pedidos da Shopee...");
    const basicOrders = await fetchShopeeOrders(creds, accessToken);
    
    if (basicOrders.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Nenhum pedido encontrado no período informado.",
          count: 0,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const orderSns = basicOrders.map((o: any) => o.order_sn).filter(Boolean);
    console.log(`Encontrados ${orderSns.length} IDs de pedidos. Buscando detalhes...`);

    // 2. Busca os detalhes completos para os pedidos encontrados (em lotes de 50)
    let detailedOrders: any[] = [];
    for (let i = 0; i < orderSns.length; i += 50) {
      const chunk = orderSns.slice(i, i + 50);
      try {
        console.log(`Buscando detalhes do lote ${i / 50 + 1}...`);
        const details = await fetchShopeeOrderDetails(creds, accessToken, chunk);
        detailedOrders = detailedOrders.concat(details);
      } catch (err) {
        console.error(`Erro ao buscar detalhes para o lote ${i / 50 + 1}:`, err);
      }
    }

    // 3. Descoberta dinâmica de colunas no banco do Supabase (OpenAPI)
    // Isso evita qualquer erro de "coluna não existe" caso o usuário tenha um banco com campos personalizados
    let dbColumns: string[] = [];
    let properties: any = {};
    try {
      console.log("Descobrindo colunas da tabela shopee_orders dinamicamente...");
      const schemaRes = await fetch(`${supabaseUrl}/rest/v1/`, {
        headers: {
          "apikey": supabaseKey,
          "Accept": "application/openapi+json",
        },
      });
      const schemaData = await schemaRes.json();
      properties = schemaData.definitions?.shopee_orders?.properties || {};
      dbColumns = Object.keys(properties);
      console.log("Colunas encontradas no banco:", dbColumns);
    } catch (e) {
      console.error("Falha ao ler o schema do banco. Usando fallback básico.", e);
      dbColumns = ["id", "user_id", "shopee_order_sn", "order_status", "customer_name", "total_amount", "create_time", "updated_at"];
    }

    // 4. Mapeia e salva os pedidos detalhados no Supabase
    let upsertCount = 0;
    for (const order of detailedOrders) {
      let createTimeStr = new Date().toISOString();
      if (order.create_time) {
        const parsedTime = Number(order.create_time);
        if (!isNaN(parsedTime) && parsedTime > 0) {
          createTimeStr = new Date(parsedTime * 1000).toISOString();
        } else {
          const parsedDate = new Date(order.create_time);
          if (!isNaN(parsedDate.getTime())) {
            createTimeStr = parsedDate.toISOString();
          }
        }
      }

      // Monta o payload dinamicamente com base nas colunas que REALMENTE existem no banco
      const payload: any = {
        user_id: user.id,
        shopee_order_sn: order.order_sn,
        order_status: order.order_status,
        updated_at: new Date().toISOString(),
      };

      if (dbColumns.includes("customer_name")) {
        payload.customer_name = order.recipient_address?.name || "Cliente Shopee";
      }
      if (dbColumns.includes("total_amount")) {
        payload.total_amount = order.total_amount !== undefined && order.total_amount !== null ? Number(order.total_amount) : 0;
      }
      if (dbColumns.includes("create_time")) {
        payload.create_time = createTimeStr;
      }

      // Mapeamento dinâmico inteligente para campos de Endereço
      if (dbColumns.includes("recipient_address")) {
        const isJsonCol = typeof properties?.recipient_address?.type === "object" || properties?.recipient_address?.type === "array";
        payload.recipient_address = isJsonCol ? order.recipient_address : (order.recipient_address?.full_address || JSON.stringify(order.recipient_address) || "");
      }
      if (dbColumns.includes("address")) {
        payload.address = order.recipient_address?.full_address || "";
      }

      // Mapeamento dinâmico inteligente para Contato
      if (dbColumns.includes("phone")) {
        payload.phone = order.recipient_address?.phone || "";
      }
      if (dbColumns.includes("customer_phone")) {
        payload.customer_phone = order.recipient_address?.phone || "";
      }

      // Mapeamento dinâmico inteligente para CPF
      if (dbColumns.includes("cpf")) {
        payload.cpf = order.buyer_cpf_id || "";
      }
      if (dbColumns.includes("buyer_cpf_id")) {
        payload.buyer_cpf_id = order.buyer_cpf_id || "";
      }

      // Mapeamento de informações adicionais
      if (dbColumns.includes("payment_method")) {
        payload.payment_method = order.payment_method || "";
      }
      if (dbColumns.includes("shipping_carrier")) {
        payload.shipping_carrier = order.shipping_carrier || "";
      }
      if (dbColumns.includes("cancel_reason")) {
        payload.cancel_reason = order.cancel_reason || "";
      }

      // Lista de Itens do Pedido (Mapeamento inteligente para colunas JSON ou String)
      if (dbColumns.includes("item_list")) {
        const isJsonCol = typeof properties?.item_list?.type === "object" || properties?.item_list?.type === "array";
        payload.item_list = isJsonCol ? order.item_list : JSON.stringify(order.item_list);
      }
      if (dbColumns.includes("items") && !payload.items) {
        const isJsonCol = typeof properties?.items?.type === "object" || properties?.items?.type === "array";
        payload.items = isJsonCol ? order.item_list : JSON.stringify(order.item_list);
      }

      const { error: orderErr } = await supabaseClient
        .from("shopee_orders")
        .upsert(payload, { onConflict: "shopee_order_sn" });

      if (orderErr) {
        console.error(`Erro ao salvar pedido ${order.order_sn}:`, orderErr);
      } else {
        upsertCount++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `${upsertCount} pedidos completos sincronizados com sucesso.`,
        count: upsertCount,
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

  console.log(`[exchangeAuthCode] Requesting: ${url}`);

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

    if (data.error && data.error !== "") {
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
  let cursor = "";
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && pageCount < 10) {
    pageCount++;
    const timestamp = Math.floor(Date.now() / 1000);

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
    console.log(`[fetchShopeeOrders] Page ${pageCount}, cursor="${cursor}"`);

    try {
      const res = await proxiedFetch(url);
      const text = await res.text();

      let data: any;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error(`[fetchShopeeOrders] Failed to parse JSON: ${text.substring(0, 200)}`);
        throw new Error(`Resposta inválida da API da Shopee.`);
      }

      if (data.error && data.error !== "" && data.error !== "error_none") {
        console.error(`[fetchShopeeOrders] Shopee API error: ${JSON.stringify(data)}`);
        throw new Error(`Shopee API Error: ${data.message || data.error}`);
      }

      const pageOrders = data.response?.order_list || [];
      allOrders = allOrders.concat(pageOrders);

      const more = data.response?.more ?? false;
      cursor = data.response?.next_cursor ?? "";
      hasMore = more && !!cursor;
    } catch (err) {
      console.error(`[fetchShopeeOrders] Request failed on page ${pageCount}: ${err.message}`);
      throw err;
    }
  }

  return allOrders;
}

async function fetchShopeeOrderDetails(creds: any, accessToken: string, orderSnList: string[]) {
  const SHOPEE_API_URL = "https://partner.shopeemobile.com";
  const path = "/api/v2/order/get_order_detail";
  const shopId = parseInt(creds.shop_id);
  const timestamp = Math.floor(Date.now() / 1000);

  // Lista robusta de todos os campos que o usuário deseja mapear
  const optionalFields = [
    "buyer_user_id",
    "buyer_username",
    "recipient_address",
    "item_list",
    "pay_time",
    "buyer_cpf_id",
    "shipping_carrier",
    "payment_method",
    "total_amount",
    "invoice_data",
    "cancel_reason",
    "cancel_by"
  ].join(",");

  const params = new URLSearchParams({
    access_token: accessToken,
    partner_id: creds.partner_id,
    shop_id: shopId.toString(),
    timestamp: timestamp.toString(),
    order_sn_list: orderSnList.join(","),
    response_optional_fields: optionalFields,
  });

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
  console.log(`[fetchShopeeOrderDetails] URL: ${url}`);

  try {
    const res = await proxiedFetch(url);
    const text = await res.text();

    let data: any;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(`[fetchShopeeOrderDetails] Failed to parse JSON: ${text.substring(0, 200)}`);
      throw new Error(`Resposta inválida nos detalhes dos pedidos.`);
    }

    if (data.error && data.error !== "" && data.error !== "error_none") {
      console.error(`[fetchShopeeOrderDetails] Shopee API error: ${JSON.stringify(data)}`);
      throw new Error(`Shopee API Error Detail: ${data.message || data.error}`);
    }

    return data.response?.order_list || [];
  } catch (err) {
    console.error(`[fetchShopeeOrderDetails] Request failed: ${err.message}`);
    throw err;
  }
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
