// Protocol adapter primitives.
//
// Each protocol (OpenAI / Gemini / ...) is a plain object implementing:
//   name             string, registry key
//   encodeRequest    Anthropic /v1/messages body → target protocol body
//   decodeResponse   target protocol response body → Anthropic response body
//   upstreamPath     target endpoint path, e.g. '/v1/chat/completions'
//   upstreamHeaders  (token) → headers object for the upstream request
//   newStreamState   (model) → per-connection stream translator with
//                    feed(chunk) → AnthropicEvent[] and flush() → AnthropicEvent[]
//
// Adding a protocol never touches router.js: drop a new adapter file in this
// directory and register it in index.js.

// An Anthropic SSE event, serialized as `event: ...\ndata: ...\n\n`.
export class AnthropicEvent {
  constructor(event, data) {
    this.event = event
    this.data = data
  }

  toSSE() {
    return `event: ${this.event}\ndata: ${JSON.stringify(this.data)}\n\n`
  }
}
