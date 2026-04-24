// UCP (Universal Commerce Protocol) types
// Spec: github.com/Universal-Commerce-Protocol/ucp
// Version: v2026-04-08

export type Price = {
  amount: number   // minor currency units (cents)
  currency: string // ISO-4217 lowercase
}

export type CheckoutStatus = "cart" | "ready" | "completed" | "canceled"

export type CheckoutItem = {
  id: string
  title: string
  quantity: number
  unit_price: Price
  total_price: Price
  image?: string
}

export type Address = {
  line_one: string
  line_two?: string
  city: string
  state: string
  country: string
  postal_code: string
}

export type CheckoutFulfillment = {
  type: "shipping" | "pickup" | "digital"
  address?: Address
  option_id: string
  option_title: string
  cost: Price
}

export type TotalLine = {
  type: "subtotal" | "tax" | "shipping" | "discount" | "final"
  amount: Price
}

export type PaymentInstrument = {
  id: string
  type: "card" | "digital_wallet" | "store_credit"
  credential?: {
    token: string
  }
  display?: string
}

export type CheckoutMessage = {
  severity: "info" | "warning" | "error"
  code: string
  message: string
}

export type CheckoutOrder = {
  id: string
  created_at: string
  status: "confirmed"
  total: Price
}

export type CheckoutObject = {
  id: string
  status: CheckoutStatus
  items: CheckoutItem[]
  buyer?: {
    name?: string
    email?: string
    phone?: string
  }
  fulfillment?: CheckoutFulfillment
  totals: TotalLine[]
  payment?: {
    instruments: PaymentInstrument[]
    available_methods: Array<{
      id: string
      type: string
      display: string
      requires_credential: boolean
    }>
  }
  messages: CheckoutMessage[]
  order?: CheckoutOrder
  created_at: string
  updated_at: string
}

// UCP meta object — required on all tool inputs
export type UCPMeta = {
  "ucp-agent": {
    profile: "dev.ucp.shopping"
  }
  "idempotency-key"?: string
}

// Tool input types
export type CreateCheckoutInput = {
  meta: UCPMeta
  checkout: {
    items: Array<{
      id: string
      quantity: number
    }>
    extensions?: {
      "dev.ucp.shopping.buyer_consent"?: Record<string, unknown>
    }
  }
}

export type GetCheckoutInput = {
  meta: UCPMeta
  checkout_id: string
}

export type UpdateCheckoutInput = {
  meta: UCPMeta
  checkout_id: string
  checkout: {
    buyer?: CheckoutObject["buyer"]
    fulfillment?: {
      type: "shipping" | "digital"
      address?: Address
      option_id: string
    }
    extensions?: Record<string, unknown>
  }
}

export type CompleteCheckoutInput = {
  meta: UCPMeta & { "idempotency-key": string }
  checkout_id: string
  payment: {
    instrument_id: string
    credential_token?: string
  }
}

export type CancelCheckoutInput = {
  meta: UCPMeta & { "idempotency-key": string }
  checkout_id: string
}

// Tool output type — all tools return this
export type UCPToolResult = {
  ucp: {
    version: "2026-04-08"
    capabilities: Record<string, boolean>
  }
  checkout: CheckoutObject
  continue_url?: string
}
