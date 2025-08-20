# Deploy Edge Function to Supabase

## Prerequisites
- Supabase CLI installed (`npm install -g supabase`)
- Logged in to Supabase CLI (`supabase login`)

## Deploy Steps

1. Link to your Supabase project:
```bash
supabase link --project-ref vxslsmwkmfcbpdtmoigw
```

2. Deploy the Edge Function:
```bash
supabase functions deploy add-to-waitlist
```

## Testing

Test the function locally:
```bash
supabase functions serve add-to-waitlist --no-verify-jwt
```

Then in another terminal:
```bash
curl -i --location --request POST 'http://localhost:54321/functions/v1/add-to-waitlist' \
  --header 'Content-Type: application/json' \
  --data '{"phone_number":"+1234567890","country_code":"US","device_id":"test_device"}'
```

## Environment Variables

The function uses these environment variables (automatically available):
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for admin access

## Rate Limits

- **IP-based**: 3 submissions per UTC day (enforced server-side)
- **Device-based**: 1 submission per UTC day (enforced client-side)