import {
  FunctionCallItem,
  ModelMessageItem,
  SemanticEvent,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
} from "@mozaik-ai/core";

/** Test-only. Do not import from production code. */

export type FakeResponse = InferenceOutput | Error;
export type FakeResponder = (
  input: InferenceInput,
  callIndex: number,
) => FakeResponse | Promise<FakeResponse>;

function output(items: InferenceOutput["items"]): InferenceOutput {
  return { items, tokenUsage: undefined, rowResponse: undefined };
}

export function fakeAnswer(text: string): InferenceOutput {
  return output([ModelMessageItem.rehydrate({ text })]);
}

export function fakeJsonAnswer(value: unknown): InferenceOutput {
  return fakeAnswer(JSON.stringify(value));
}

export function fakeToolCall(
  name: string,
  args: unknown,
  callId = `call_${name}`,
): InferenceOutput {
  return output([FunctionCallItem.rehydrate({ callId, name, args: JSON.stringify(args) })]);
}

export class FakeRunner implements InferenceRunner {
  /** Every input received, in order (`stream` calls included). */
  readonly calls: InferenceInput[] = [];

  constructor(private readonly responder: FakeResponder) {}

  /** Responses are consumed in order; an `Error` entry makes that call fail. Running dry fails too. */
  static fromQueue(queue: readonly FakeResponse[]): FakeRunner {
    return new FakeRunner((_input, index) => {
      const next = queue[index];
      return next ?? new Error(`FakeRunner queue exhausted at call ${index}`);
    });
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const index = this.calls.length;
    this.calls.push(input);
    const response = await this.responder(input, index);
    if (response instanceof Error) throw response;
    return response;
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    const result = await this.run(input);
    yield SemanticEvent.create("inference.output", "system", result);
  }
}
