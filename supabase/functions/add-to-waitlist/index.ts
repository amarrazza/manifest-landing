// CORS-first, lazy import supabase-js, robust preflight handling, IP rate-limit (3/day UTC)

// Helper to ensure required env vars are present at cold start
function need(key: string): string {
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// Load and validate all required env vars at cold start
const SUPABASE_URL = need("SUPABASE_URL");
const SERVICE_ROLE = need("SUPABASE_SERVICE_ROLE_KEY");
const IP_HASH_SALT = need("IP_HASH_SALT");

// Allowed origins whitelist for CORS
const ALLOWED_ORIGINS = [
  'http://localhost:8000',
  'https://manifestios.com',
  'https://www.manifestios.com'
];

function makeCorsHeaders(req: Request) {
  const origin = req.headers.get("origin");
  const reqHeaders =
    req.headers.get("access-control-request-headers") ?? "content-type";
  
  // Only set Access-Control-Allow-Origin if origin is in whitelist
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
  
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    corsHeaders["Access-Control-Allow-Origin"] = origin;
  }
  
  return corsHeaders;
}

function getClientIP(req: Request): string {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return h.get("cf-connecting-ip") || h.get("x-real-ip") || "0.0.0.0";
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function startOfTodayUTC(): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `${day}T00:00:00.000Z`;
}

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);

  // --- Preflight must NEVER error ---
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: cors });
  }

  // Enforce origin check for non-OPTIONS requests
  const origin = req.headers.get('origin');
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: cors
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: cors,
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { phone_number, country_code, ip_country, device_id } = body ?? {};

    if (!phone_number) {
      return new Response(JSON.stringify({ error: "Phone number is required" }), {
        status: 400,
        headers: cors,
      });
    }

    // Lazy import to avoid crashing OPTIONS on module fetch issues
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Compute short hash (16 hex chars) for the IP
    const ip = getClientIP(req);
    const ip_hash = (await sha256Hex(ip + IP_HASH_SALT)).slice(0, 16);

    // Count today's submissions (UTC) for this IP without fetching rows
    const since = startOfTodayUTC();
    const { count: ipCount, error: countErr } = await supabase
      .from("waitlist")
      .select("*", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", since);

    if (countErr) {
      return new Response(JSON.stringify({ error: "Failed to check rate limit" }), {
        status: 500,
        headers: cors,
      });
    }

    if ((ipCount ?? 0) >= 3) {
      return new Response(
        JSON.stringify({
          error: "IP limit reached (3 per UTC day). Try again tomorrow.",
          code: "RATE_LIMIT_IP",
        }),
        { status: 429, headers: cors },
      );
    }

    // Insert the record
    const { data, error: insertErr } = await supabase
      .from("waitlist")
      .insert({
        phone_number,
        country_code: country_code?.toString().toUpperCase(),
        ip_country: ip_country?.toString().toUpperCase(),
        device_id,
        ip_hash,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr) {
      // Surface unique constraint as friendly message if you added one on phone_number
      const duplicate =
        insertErr.code === "23505" || /duplicate key|unique/i.test(insertErr.message);
      const msg = duplicate
        ? "This number is already on the waitlist!"
        : "Failed to add to waitlist";
      const status = duplicate ? 409 : 500;
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: cors,
      });
    }

    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: cors,
    });
  } catch (e) {
    // Never let exceptions drop CORS
    return new Response(
      JSON.stringify({ error: "Unhandled error", details: String(e) }),
      { status: 500, headers: cors },
    );
  }
});
