import { SemanticEvent, SituationSpecification, createHuman, type Human } from "@mozaik-ai/core";
import { STAGE_FAILED, join, leave, resolveRuntime } from "./runtime.js";

export const HANDLER_FAILED = "coordinator.handler_failed";

export interface HandlerFailedPayload {
  eventType: string;
  error: string;
}

export interface CoordinatorLogger {
  error(obj: object, msg: string): void;
  debug?(obj: object, msg: string): void;
}

export type DomainHandler<P = unknown> = (payload: P, event: SemanticEvent) => Promise<void> | void;

export type CoordinatorListener = (event: SemanticEvent) => void;

class AnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

/**
 * Orchestration by reaction: an observer participant that runs registered handlers when a
 * domain event appears on the runtime, and emits the next domain event itself. It is the only
 * code that persists pipeline results. Agent calls inside handlers go through `runStage`.
 *
 * Mozaik runs event handlers synchronously inside `publish`, so handlers are detached from
 * that call stack and their errors never propagate into the publishing agent's loop.
 */
export class Coordinator {
  private readonly human: Human;
  private readonly logger: CoordinatorLogger;
  private readonly handlers = new Map<string, DomainHandler[]>();
  private readonly listeners = new Set<CoordinatorListener>();
  private started = false;

  constructor(options: { logger: CoordinatorLogger }) {
    this.logger = options.logger;
    this.human = createHuman({
      name: "Coordinator",
      capabilities: [],
      handlers: [
        {
          specification: new AnyEvent(),
          processor: { apply: ({ event }) => this.receive(event) },
        },
      ],
    });
  }

  get id(): string {
    return this.human.getId();
  }

  start(): void {
    if (this.started) return;
    join(this.human);
    this.started = true;
  }

  /**
   * Stops reacting to events. Handlers already running are not interrupted; handlers queued
   * by `receive` that have not started yet are skipped (not treated as failures).
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    leave(this.human);
  }

  /** Runs `handler` whenever a `eventType` event appears. Returns an unsubscribe function. */
  on<P = unknown>(eventType: string, handler: DomainHandler<P>): () => void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler as DomainHandler);
    this.handlers.set(eventType, list);
    return () => {
      const current = this.handlers.get(eventType);
      if (!current) return;
      const index = current.indexOf(handler as DomainHandler);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /** Publishes a domain event on the runtime. */
  emit<P>(eventType: string, payload: P): void {
    if (!this.started) throw new Error("Coordinator is not started");
    resolveRuntime().publish(SemanticEvent.create(eventType, this.id, payload));
  }

  /**
   * Listens to every domain event the coordinator emits, plus `stage.failed` and
   * `coordinator.handler_failed`. Called synchronously in event order; keep it quick.
   */
  subscribe(listener: CoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Runs inside `publish`: must not throw and must not run handler bodies. */
  private receive(event: SemanticEvent): void {
    try {
      if (event.producerId === this.id || event.type === STAGE_FAILED) this.notify(event);
      for (const handler of [...(this.handlers.get(event.type) ?? [])]) {
        void Promise.resolve()
          .then(() => {
            if (!this.started) {
              this.logger.debug?.(
                { eventType: event.type },
                "coordinator stopped; handler skipped",
              );
              return;
            }
            return handler(event.payload, event);
          })
          .catch((error: unknown) => this.handlerFailed(event.type, error));
      }
    } catch (error) {
      this.logger.error({ err: error, eventType: event.type }, "coordinator dispatch failed");
    }
  }

  private notify(event: SemanticEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ err: error, eventType: event.type }, "coordinator listener failed");
      }
    }
  }

  private handlerFailed(eventType: string, error: unknown): void {
    this.logger.error({ err: error, eventType }, "coordinator handler failed");
    const payload: HandlerFailedPayload = {
      eventType,
      error: error instanceof Error ? error.message : String(error),
    };
    // A failing handler of the failure event itself must not trigger itself forever.
    if (eventType === HANDLER_FAILED) return;
    try {
      this.emit(HANDLER_FAILED, payload);
    } catch (emitError) {
      this.logger.error({ err: emitError }, "could not publish coordinator.handler_failed");
    }
  }
}
