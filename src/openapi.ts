/** OpenAPI 3.1 document, served at /openapi.json and rendered at /docs. */
import type { Config } from './config.js';
import type { StellarGateway } from './stellar.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const dec = (description: string, example: string) => ({ type: 'string', pattern: '^\\d+(\\.\\d+)?$', description, example });
const json = (schema: unknown, required = true) => ({ required, content: { 'application/json': { schema } } });
const resp = (description: string, schema?: unknown) => (schema ? { description, content: { 'application/json': { schema } } } : { description });
const list = (item: string) => ({
  type: 'object',
  properties: { data: { type: 'array', items: ref(item) }, limit: { type: 'integer' }, offset: { type: 'integer' } },
});
const err = (code: string, description: string) => resp(description, { ...ref('Error'), example: { error: { code, message: description } } });
const id = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const paging = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
];

export function buildOpenApi(cfg: Config, stellar: StellarGateway) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'TR Mock Anchor API',
      version: '1.0.0',
      summary: 'Mock Turkish TRY <-> USDC on/off-ramp on Stellar testnet',
      description: [
        'A sandbox that behaves like an API-key based Turkish exchange ramp, for builders who want to integrate TRY on/off-ramps before a production anchor is available.',
        '',
        '**How Turkish on-ramps work (and what this mocks):** the customer sends TRY by bank transfer (FAST/EFT/Havale) to the exchange\'s IBAN and writes a personal *reference code* in the description. The exchange matches the transfer, credits a TRY balance, and the customer then buys USDC at the USD/TRY rate and withdraws it to a Stellar wallet. Off-ramp is the reverse: send USDC to the anchor\'s Stellar address with a memo, receive TRY on the balance, pay out to an IBAN.',
        '',
        '**What is real here:** the Stellar leg. On-ramps pay real testnet USDC from the treasury to the destination (payment, or claimable balance when the wallet is unfunded / has no trustline). Off-ramps are detected from real testnet payments to the treasury. **What is simulated:** the bank. Use `POST /v1/sandbox/bank-transfers` to play the role of the incoming TRY transfer.',
        '',
        `**Auth:** create an account (dashboard or \`POST /v1/partners\`) and send your single API key as \`X-API-Key\`. Rates come from Reflector's USD/TRY oracle on Stellar mainnet (fallback: static), with a ${cfg.spreadBps} bps spread each side.`,
      ].join('\n'),
      contact: { name: 'TR Mock Anchor', url: cfg.publicUrl },
    },
    servers: [{ url: cfg.publicUrl }],
    security: [{ ApiKey: [] }],
    tags: [
      { name: 'Account', description: 'Sandbox accounts and API keys (one key per account).' },
      { name: 'Customers', description: 'End users of your app. KYC is instant in the sandbox (magic first names: REJECT, PENDING).' },
      { name: 'Rates & Quotes', description: 'USDC/TRY pricing. Quotes lock a rate for 120 seconds.' },
      { name: 'On-ramp', description: 'TRY balance -> USDC on Stellar.' },
      { name: 'Off-ramp', description: 'USDC on Stellar -> TRY balance -> bank payout.' },
      { name: 'Payouts', description: 'TRY balance -> bank account (simulated FAST transfer).' },
      { name: 'Webhooks & Events', description: 'Push (HMAC-signed webhooks) or pull (event log).' },
      { name: 'Sandbox', description: 'Stand-ins for the bank, compliance and (in fake mode) the chain.' },
      { name: 'Public', description: 'No auth.' },
    ],
    paths: {
      '/health': { get: { tags: ['Public'], security: [], summary: 'Service, treasury and rate status', responses: { 200: resp('OK') } } },
      '/.well-known/stellar.toml': { get: { tags: ['Public'], security: [], summary: 'SEP-1 stellar.toml (sandbox)', responses: { 200: { description: 'TOML' } } } },
      '/v1/partners': {
        post: {
          tags: ['Account'], security: [], summary: 'Create an account and get its API key',
          requestBody: json({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 }, name: { type: 'string' } } }),
          responses: { 201: resp('Account with api_key (shown here and in the dashboard)', ref('Partner')), 409: err('email_taken', 'Email already registered') },
        },
      },
      '/v1/partners/me': { get: { tags: ['Account'], summary: 'Who am I', responses: { 200: resp('Partner', ref('Partner')) } } },
      '/v1/partners/me/rotate-key': { post: { tags: ['Account'], summary: 'Rotate the API key (old key stops working)', responses: { 200: resp('Partner with new api_key', ref('Partner')) } } },

      '/v1/customers': {
        post: {
          tags: ['Customers'], summary: 'Create a customer',
          description: 'Returns the customer with a unique `deposit_reference`. KYC is approved instantly unless `first_name` is `REJECT` or `PENDING`. `tckn` (T.C. Kimlik No) and `iban` are validated when given; test TCKN: `10000000146`.',
          requestBody: json(ref('CustomerCreate')),
          responses: { 201: resp('Customer', ref('Customer')), 400: err('invalid_iban', 'Validation failed'), 409: err('duplicate_external_id', 'external_id already used') },
        },
        get: { tags: ['Customers'], summary: 'List customers', parameters: paging, responses: { 200: resp('List', list('Customer')) } },
      },
      '/v1/customers/{id}': {
        get: { tags: ['Customers'], summary: 'Get a customer', parameters: [id('id')], responses: { 200: resp('Customer', ref('Customer')), 404: err('not_found', 'Not found') } },
        patch: { tags: ['Customers'], summary: 'Update iban / email', parameters: [id('id')], requestBody: json({ type: 'object', properties: { iban: { type: 'string', nullable: true }, email: { type: 'string', nullable: true } } }), responses: { 200: resp('Customer', ref('Customer')) } },
      },
      '/v1/customers/{id}/deposit-instructions': {
        get: { tags: ['Customers', 'On-ramp'], summary: 'Bank details + reference for TRY deposits', parameters: [id('id')], responses: { 200: resp('Instructions', ref('DepositInstructions')) } },
      },
      '/v1/customers/{id}/balances': { get: { tags: ['Customers'], summary: 'TRY and USDC balances', parameters: [id('id')], responses: { 200: resp('Balances', { type: 'object', properties: { customer_id: { type: 'string' }, balances: ref('Balances'), as_of: { type: 'string' } } }) } } },
      '/v1/customers/{id}/ledger': { get: { tags: ['Customers'], summary: 'Balance movements', parameters: [id('id'), ...paging], responses: { 200: resp('List', list('LedgerEntry')) } } },
      '/v1/customers/{id}/bank-transfers': { get: { tags: ['Customers'], summary: 'Incoming TRY transfers for a customer', parameters: [id('id'), ...paging], responses: { 200: resp('List', list('BankTransfer')) } } },

      '/v1/rates': { get: { tags: ['Rates & Quotes'], summary: 'Current USDC/TRY mid, buy and sell rates', responses: { 200: resp('Rates', ref('Rates')) } } },
      '/v1/quotes': {
        post: {
          tags: ['Rates & Quotes'], summary: 'Lock a rate for 120 seconds',
          description: '`buy` = TRY -> USDC (on-ramp), `sell` = USDC -> TRY (off-ramp). Fix either side of the conversion with `amount_currency`.',
          requestBody: json(ref('QuoteCreate')),
          responses: { 201: resp('Quote', ref('Quote')) },
        },
      },
      '/v1/quotes/{id}': { get: { tags: ['Rates & Quotes'], summary: 'Get a quote', parameters: [id('id')], responses: { 200: resp('Quote', ref('Quote')) } } },

      '/v1/onramps': {
        post: {
          tags: ['On-ramp'], summary: 'Buy USDC with the TRY balance and send it to a Stellar address',
          description: `Debits the customer's TRY balance immediately and creates a \`pending\` order. A worker pays ${stellar.assetCode} from the treasury within seconds: a regular payment if the destination has a trustline, otherwise a claimable balance the wallet can claim later. Failed sends refund the TRY. Pass \`quote_id\` for a locked rate or \`amount_try\` for the live rate. Limits: ${cfg.minOnrampTry} - ${cfg.maxOnrampTry} TRY.`,
          requestBody: json(ref('OnrampCreate')),
          responses: { 201: resp('On-ramp (pending)', ref('Onramp')), 422: err('insufficient_balance', 'Not enough TRY / KYC not approved / quote expired / below minimum') },
        },
        get: { tags: ['On-ramp'], summary: 'List on-ramps', parameters: [{ name: 'customer_id', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'completed', 'failed'] } }, ...paging], responses: { 200: resp('List', list('Onramp')) } },
      },
      '/v1/onramps/{id}': { get: { tags: ['On-ramp'], summary: 'Get an on-ramp (poll until completed/failed)', parameters: [id('id')], responses: { 200: resp('On-ramp', ref('Onramp')) } } },

      '/v1/offramps': {
        post: {
          tags: ['Off-ramp'], summary: 'Start an off-ramp: get a deposit address + memo',
          description: `Returns the treasury address and a numeric memo. Send ${stellar.assetCode} there on Stellar testnet (memo type **id**, or a muxed address with that id). When the payment lands, the received amount is sold for TRY at the locked rate (locked for ${cfg.offrampRateLockSeconds}s, then repriced) and, with \`auto_payout\`, paid to the IBAN instantly. Payments without a usable memo are parked as unmatched deposits.`,
          requestBody: json(ref('OfframpCreate')),
          responses: { 201: resp('Off-ramp (awaiting_deposit)', ref('Offramp')), 422: err('missing_iban', 'auto_payout needs an IBAN') },
        },
        get: { tags: ['Off-ramp'], summary: 'List off-ramps', parameters: [{ name: 'customer_id', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['awaiting_deposit', 'completed', 'cancelled'] } }, ...paging], responses: { 200: resp('List', list('Offramp')) } },
      },
      '/v1/offramps/{id}': { get: { tags: ['Off-ramp'], summary: 'Get an off-ramp (poll until completed)', parameters: [id('id')], responses: { 200: resp('Off-ramp', ref('Offramp')) } } },
      '/v1/offramps/{id}/cancel': { post: { tags: ['Off-ramp'], summary: 'Cancel an off-ramp that has not received a deposit', parameters: [id('id')], responses: { 200: resp('Off-ramp', ref('Offramp')) } } },

      '/v1/payouts': {
        post: { tags: ['Payouts'], summary: 'Withdraw TRY balance to a bank account', requestBody: json(ref('PayoutCreate')), responses: { 201: resp('Payout', ref('Payout')) } },
        get: { tags: ['Payouts'], summary: 'List payouts', parameters: [{ name: 'customer_id', in: 'query', schema: { type: 'string' } }, ...paging], responses: { 200: resp('List', list('Payout')) } },
      },
      '/v1/payouts/{id}': { get: { tags: ['Payouts'], summary: 'Get a payout', parameters: [id('id')], responses: { 200: resp('Payout', ref('Payout')) } } },

      '/v1/webhooks': {
        post: {
          tags: ['Webhooks & Events'], summary: 'Register a webhook',
          description: 'Deliveries are POSTed as JSON with header `X-TRMA-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Retries: 5s, 30s, 2m, 10m.',
          requestBody: json(ref('WebhookCreate')),
          responses: { 201: resp('Webhook with secret (shown once)', ref('Webhook')) },
        },
        get: { tags: ['Webhooks & Events'], summary: 'List webhooks', responses: { 200: resp('List', { type: 'object', properties: { data: { type: 'array', items: ref('Webhook') } } }) } },
      },
      '/v1/webhooks/{id}': { delete: { tags: ['Webhooks & Events'], summary: 'Delete a webhook', parameters: [id('id')], responses: { 204: resp('Deleted') } } },
      '/v1/webhooks/{id}/deliveries': { get: { tags: ['Webhooks & Events'], summary: 'Delivery attempts', parameters: [id('id'), ...paging], responses: { 200: resp('List') } } },
      '/v1/events': {
        get: {
          tags: ['Webhooks & Events'], summary: 'Poll the event log',
          parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'after', in: 'query', schema: { type: 'string' }, description: 'Event id cursor; returns events after it' }, paging[0]!],
          responses: { 200: resp('Events', { type: 'object', properties: { data: { type: 'array', items: ref('Event') }, next_after: { type: 'string', nullable: true }, event_types: { type: 'array', items: { type: 'string' } } } }) },
        },
      },

      '/v1/sandbox/bank-transfers': {
        post: {
          tags: ['Sandbox', 'On-ramp'], summary: 'Simulate an incoming TRY bank transfer',
          description: 'Plays the bank: "a transfer with this description arrived". Matched by `reference` (the customer\'s deposit_reference) or directly by `customer_id`. Unknown references are stored as `unmatched` (HTTP 202) and can be assigned later, like a support desk would.',
          requestBody: json(ref('BankTransferCreate')),
          responses: { 201: resp('Matched and credited', ref('BankTransfer')), 202: resp('Unmatched, held', ref('BankTransfer')) },
        },
        get: { tags: ['Sandbox'], summary: 'List simulated bank transfers', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['matched', 'unmatched'] } }, ...paging], responses: { 200: resp('List', list('BankTransfer')) } },
      },
      '/v1/sandbox/bank-transfers/{id}/assign': { post: { tags: ['Sandbox'], summary: 'Assign an unmatched transfer to a customer', parameters: [id('id')], requestBody: json({ type: 'object', required: ['customer_id'], properties: { customer_id: { type: 'string' } } }), responses: { 200: resp('Matched', ref('BankTransfer')) } } },
      '/v1/sandbox/customers/{id}/kyc': { post: { tags: ['Sandbox'], summary: 'Set KYC status', parameters: [id('id')], requestBody: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['approved', 'pending', 'rejected'] } } }), responses: { 200: resp('Customer', ref('Customer')) } } },
      '/v1/sandbox/treasury': { get: { tags: ['Sandbox'], summary: 'Treasury address and USDC balance', responses: { 200: resp('Treasury') } } },
      '/v1/sandbox/unmatched-deposits': { get: { tags: ['Sandbox', 'Off-ramp'], summary: 'USDC that arrived without a usable memo (all partners)', parameters: paging, responses: { 200: resp('List') } } },
      '/v1/sandbox/usdc-deposits': { post: { tags: ['Sandbox'], summary: 'Fake-Stellar mode only: simulate an inbound USDC payment', requestBody: json({ type: 'object', required: ['amount_usdc'], properties: { offramp_id: { type: 'string' }, memo_id: { type: 'string' }, amount_usdc: dec('USDC amount', '25.0000000'), from: { type: 'string' } } }), responses: { 202: resp('Queued'), 422: err('live_stellar', 'Server runs against real testnet') } } },
    },
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Your account\'s single API key. `Authorization: Bearer <key>` also works.' },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } },
        Partner: { type: 'object', properties: { id: { type: 'string', example: 'prt_…' }, name: { type: 'string' }, email: { type: 'string' }, api_key_prefix: { type: 'string' }, api_key: { type: 'string', description: 'Only in responses that create or rotate a key, and in the dashboard.' }, created_at: { type: 'string' }, key_rotated_at: { type: 'string', nullable: true } } },
        Balances: { type: 'object', properties: { TRY: dec('TRY balance, 2 decimals', '1500.00'), USDC: dec('USDC balance, 7 decimals', '0.0000000') } },
        CustomerCreate: {
          type: 'object', required: ['first_name', 'last_name'],
          properties: {
            external_id: { type: 'string', description: 'Your own user id (unique per account)' },
            first_name: { type: 'string', example: 'Ayşe' }, last_name: { type: 'string', example: 'Yılmaz' },
            email: { type: 'string', format: 'email' },
            tckn: { type: 'string', description: 'T.C. Kimlik No, 11 digits with checksum', example: '10000000146' },
            iban: { type: 'string', description: 'Turkish IBAN for payouts', example: 'TR330006100519786457841326' },
          },
        },
        Customer: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'cus_…' }, external_id: { type: 'string', nullable: true }, first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string', nullable: true },
            tckn: { type: 'string', nullable: true }, iban: { type: 'string', nullable: true }, kyc_status: { type: 'string', enum: ['approved', 'pending', 'rejected'] },
            deposit_reference: { type: 'string', example: 'TRMA-7K2M-Q9XZ', description: 'The customer writes this in the bank transfer description' },
            balances: ref('Balances'), created_at: { type: 'string' }, updated_at: { type: 'string' },
          },
        },
        DepositInstructions: {
          type: 'object',
          properties: {
            customer_id: { type: 'string' }, method: { type: 'string', example: 'bank_transfer' }, rails: { type: 'array', items: { type: 'string' }, example: ['FAST', 'EFT', 'Havale'] }, currency: { type: 'string', example: 'TRY' },
            bank_name: { type: 'string' }, account_holder: { type: 'string' }, iban: { type: 'string' }, iban_formatted: { type: 'string' }, reference: { type: 'string' },
            instructions: { type: 'object', properties: { en: { type: 'string' }, tr: { type: 'string' } } }, sandbox_hint: { type: 'string' },
          },
        },
        BankTransferCreate: {
          type: 'object', required: ['amount_try'],
          properties: { reference: { type: 'string', description: 'Text the sender wrote in the description', example: 'TRMA-7K2M-Q9XZ' }, customer_id: { type: 'string', description: 'Alternative to reference' }, amount_try: dec('TRY amount', '1000.00'), sender_name: { type: 'string' }, sender_iban: { type: 'string' } },
        },
        BankTransfer: { type: 'object', properties: { id: { type: 'string', example: 'bt_…' }, customer_id: { type: 'string', nullable: true }, reference: { type: 'string', nullable: true }, amount_try: { type: 'string' }, currency: { type: 'string' }, sender_name: { type: 'string', nullable: true }, sender_iban: { type: 'string', nullable: true }, status: { type: 'string', enum: ['matched', 'unmatched'] }, created_at: { type: 'string' }, matched_at: { type: 'string', nullable: true } } },
        Rates: { type: 'object', properties: { pair: { type: 'string', example: 'USDC/TRY' }, mid_rate: { type: 'string' }, buy_rate: { type: 'string' }, sell_rate: { type: 'string' }, spread_bps: { type: 'integer' }, rate_source: { type: 'string', enum: ['reflector', 'static', 'static_fallback'] }, oracle_timestamp: { type: 'integer', nullable: true }, fetched_at: { type: 'string' } } },
        QuoteCreate: { type: 'object', required: ['side', 'amount', 'amount_currency'], properties: { customer_id: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, amount: dec('Amount in amount_currency', '1000.00'), amount_currency: { type: 'string', enum: ['TRY', 'USDC'] } } },
        Quote: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'qt_…' }, customer_id: { type: 'string', nullable: true }, side: { type: 'string', enum: ['buy', 'sell'] }, pair: { type: 'string' }, rate: { type: 'string', example: '47.737500' }, mid_rate: { type: 'string' }, spread_bps: { type: 'integer' }, rate_source: { type: 'string' },
            source_currency: { type: 'string' }, source_amount: { type: 'string' }, destination_currency: { type: 'string' }, destination_amount: { type: 'string' }, expires_at: { type: 'string' }, consumed_by: { type: 'string', nullable: true }, created_at: { type: 'string' },
          },
        },
        OnrampCreate: { type: 'object', required: ['customer_id', 'destination_address'], properties: { customer_id: { type: 'string' }, destination_address: { type: 'string', description: 'Stellar G… or M… address', example: 'GB…' }, amount_try: dec('TRY to spend (when no quote_id)', '1000.00'), quote_id: { type: 'string' }, memo: { type: 'string', maxLength: 28, description: 'Optional text memo on the payment' } } },
        Onramp: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'onr_…' }, type: { type: 'string', example: 'onramp' }, customer_id: { type: 'string' }, quote_id: { type: 'string', nullable: true }, amount_try: { type: 'string' }, amount_usdc: { type: 'string' }, rate: { type: 'string' },
            destination_address: { type: 'string' }, memo: { type: 'string', nullable: true }, status: { type: 'string', enum: ['pending', 'completed', 'failed'] }, pending_reason: { type: 'string', nullable: true, description: 'e.g. treasury_low, retrying: …' },
            settlement: { type: 'string', nullable: true, enum: ['payment', 'claimable_balance', null] }, stellar_tx_hash: { type: 'string', nullable: true }, claimable_balance_id: { type: 'string', nullable: true }, failure_reason: { type: 'string', nullable: true },
            created_at: { type: 'string' }, updated_at: { type: 'string' }, completed_at: { type: 'string', nullable: true },
          },
        },
        OfframpCreate: { type: 'object', required: ['customer_id'], properties: { customer_id: { type: 'string' }, amount_usdc: dec('Expected USDC (informational; the received amount is what gets converted)', '25.0000000'), quote_id: { type: 'string' }, auto_payout: { type: 'boolean', default: true, description: 'Pay TRY to the IBAN as soon as the deposit lands' }, payout_iban: { type: 'string', description: 'Defaults to customer.iban' } } },
        Offramp: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'ofr_…' }, type: { type: 'string', example: 'offramp' }, customer_id: { type: 'string' }, quote_id: { type: 'string', nullable: true }, status: { type: 'string', enum: ['awaiting_deposit', 'completed', 'cancelled'] },
            expected_usdc: { type: 'string', nullable: true }, received_usdc: { type: 'string', nullable: true }, amount_try: { type: 'string', nullable: true }, rate: { type: 'string' }, rate_locked_until: { type: 'string' }, repriced: { type: 'boolean' },
            deposit: { type: 'object', properties: { network: { type: 'string' }, asset_code: { type: 'string' }, asset_issuer: { type: 'string' }, address: { type: 'string' }, memo_type: { type: 'string', example: 'id' }, memo: { type: 'string', example: '482913005771' }, instructions: { type: 'string' } } },
            auto_payout: { type: 'boolean' }, payout_iban: { type: 'string', nullable: true }, payout_id: { type: 'string', nullable: true }, stellar_tx_hash: { type: 'string', nullable: true }, from_address: { type: 'string', nullable: true }, failure_reason: { type: 'string', nullable: true },
            created_at: { type: 'string' }, updated_at: { type: 'string' }, completed_at: { type: 'string', nullable: true },
          },
        },
        PayoutCreate: { type: 'object', required: ['customer_id', 'amount_try'], properties: { customer_id: { type: 'string' }, amount_try: dec('TRY amount', '500.00'), iban: { type: 'string', description: 'Defaults to customer.iban' } } },
        Payout: { type: 'object', properties: { id: { type: 'string', example: 'po_…' }, customer_id: { type: 'string' }, offramp_id: { type: 'string', nullable: true }, amount_try: { type: 'string' }, currency: { type: 'string' }, iban: { type: 'string' }, rail: { type: 'string', example: 'FAST' }, bank_reference: { type: 'string' }, status: { type: 'string', example: 'completed' }, created_at: { type: 'string' } } },
        WebhookCreate: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' }, default: ['*'], description: 'Event types or ["*"]' } } },
        Webhook: { type: 'object', properties: { id: { type: 'string', example: 'wh_…' }, url: { type: 'string' }, events: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' }, secret: { type: 'string', description: 'Only on creation' }, signature_scheme: { type: 'string' }, created_at: { type: 'string' } } },
        Event: { type: 'object', properties: { id: { type: 'string', example: 'evt_…' }, type: { type: 'string', example: 'onramp.completed' }, created_at: { type: 'string' }, data: { type: 'object' } } },
        LedgerEntry: { type: 'object', properties: { id: { type: 'string' }, currency: { type: 'string', enum: ['TRY', 'USDC'] }, delta: { type: 'string' }, balance_after: { type: 'string' }, kind: { type: 'string', example: 'bank_transfer | onramp | onramp_refund | offramp_deposit | offramp_convert | payout' }, ref_id: { type: 'string', nullable: true }, created_at: { type: 'string' } } },
      },
    },
  };
}
