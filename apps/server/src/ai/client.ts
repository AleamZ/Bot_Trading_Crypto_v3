/**
 * Minimal client for an OpenAI-compatible /chat/completions endpoint (the router on the VPS, or any
 * provider that speaks the same API). The API key never appears in errors or logs.
 */

export type AiErrorCode = "TIMEOUT" | "NETWORK" | "HTTP" | "EMPTY";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text as the model wrote it. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface AiReply {
  model: string;
  content: string;
  toolCalls: ToolCall[];
}

export interface AiConfig {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  timeoutMs: number;
}

export interface ChatOptions {
  tools?: ToolSpec[];
  /** Ask for a JSON object (retried without when the server does not support response_format). */
  json?: boolean;
  temperature?: number;
  timeoutMs?: number;
}

export class AiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  get model(): string {
    return this.config.model;
  }

  /** The endpoint's host, safe to show in the UI. */
  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<AiReply> {
    try {
      return await this.post(messages, options, options.json === true);
    } catch (error) {
      // Some servers reject response_format: ask again without it.
      if (options.json && error instanceof AiError && error.code === "HTTP" && error.status === 400) return this.post(messages, options, false);
      throw error;
    }
  }

  private async post(messages: ChatMessage[], options: ChatOptions, json: boolean): Promise<AiReply> {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? 0.2,
      stream: false,
    };
    if (json) body.response_format = { type: "json_object" };
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch (error) {
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new AiError("TIMEOUT", `AI không trả lời trong ${Math.round(timeoutMs / 1000)} giây`);
      throw new AiError("NETWORK", `Không gọi được AI tại ${this.host}: ${(error as Error).message}`);
    }
    if (!response.ok) throw new AiError("HTTP", `AI trả lỗi ${response.status}: ${text.slice(0, 300)}`, response.status);

    let parsed: Completion | null;
    try {
      parsed = JSON.parse(text) as Completion | null;
    } catch {
      throw new AiError("EMPTY", "AI trả về nội dung không phải JSON");
    }
    const message = parsed?.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content : "";
    const toolCalls: ToolCall[] = (Array.isArray(message?.tool_calls) ? message.tool_calls : []).flatMap((call, i) => {
      const name = call.function?.name;
      if (typeof name !== "string" || !name) return [];
      const args = call.function?.arguments;
      return [{ id: typeof call.id === "string" && call.id ? call.id : `call_${i}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }];
    });
    if (!content.trim() && toolCalls.length === 0) throw new AiError("EMPTY", "AI trả lời rỗng");
    return { model: typeof parsed?.model === "string" && parsed.model ? parsed.model : this.config.model, content, toolCalls };
  }
}

interface Completion {
  model?: unknown;
  choices?: { message?: { content?: unknown; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] } }[];
}

/** The first JSON object in a reply (models sometimes wrap it in ``` fences or add a sentence). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Không thấy JSON trong câu trả lời của AI");
  return JSON.parse(candidate.slice(start, end + 1));
}
