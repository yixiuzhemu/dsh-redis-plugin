/**
 * Ambient type shims for the DeepSeek Harness (dsh) SDK packages.
 *
 * These host packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
 * `@deepseek-ai/schemastery`) are declared as *optional peer dependencies*:
 * they are provided at runtime by the dsh host when this bundle is loaded into
 * a profile, so they are NOT installed here. The declarations below describe
 * only the surface this plugin consumes, allowing the project to type-check and
 * build standalone.
 *
 * NOTE: When developing inside the real dsh monorepo (where the actual packages
 * are linked), delete this file so the genuine SDK types take precedence.
 */

declare module '@deepseek-ai/cordis' {
  /** Disposable handle returned by reversible registrations. */
  export type Disposer = () => void | Promise<void>

  export interface Logger {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }

  /** Minimal structural view of the Cordis context used by this plugin. */
  export interface Context {
    logger: Logger
    /** Provide a service onto a stable context key for other plugins to inject. */
    provide<T>(key: string, value: T): Disposer
    /** Read a service from the global registry (optional dependency). */
    get<T = unknown>(key: string): T | undefined
    /** Register a reversible effect; the returned disposer runs on unload/HMR. */
    effect(setup: () => void | Disposer): Disposer
    /** Register a reversible event listener. */
    on(event: string, listener: (...args: any[]) => any): Disposer
    /** Tool registry service (present when the tools capability is loaded). */
    tools?: ToolRegistry
    [key: string]: any
  }

  export interface ToolRegistry {
    register(definition: unknown): Disposer
    guard?(name: string, fn: (...args: any[]) => any): Disposer
  }

  /** Base class for services exposed on `ctx.<key>`. */
  export class Service {
    constructor(ctx: Context, key: string)
    ctx: Context
  }
}

declare module '@deepseek-ai/dsh-tools' {
  import type { Disposer } from '@deepseek-ai/cordis'

  export interface ToolParamSchema {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array'
    required?: boolean
    description?: string
    default?: unknown
    enum?: unknown[]
    items?: ToolParamSchema
    properties?: Record<string, ToolParamSchema>
  }

  export interface ToolExecution {
    name: string
    args: Record<string, unknown>
    signal: AbortSignal
  }

  export type PreToolDecision =
    | { kind: 'allow' }
    | { kind: 'deny'; reason: string }
    | { kind: 'ask'; reason: string }

  export interface ToolDefinition {
    name: string
    description: string
    parameters?: Record<string, ToolParamSchema>
    output?: {
      schema?: ToolParamSchema
      render?: (args: any, value: any) => Array<{ type: string; text?: string; [k: string]: unknown }>
    }
    execute(args: any, exec: ToolExecution): Promise<unknown>
    [key: string]: unknown
  }

  export function defineTool(def: ToolDefinition): ToolDefinition
}

declare module '@deepseek-ai/schemastery' {
  /** Permissive, chainable schema builder mirroring the schemastery API. */
  export interface Schema {
    required(): Schema
    optional(): Schema
    default(value: unknown): Schema
    description(text: string): Schema
    [key: string]: any
  }
  export interface SchemaConstructor {
    any(): Schema
    string(): Schema
    number(): Schema
    boolean(): Schema
    literal(value: unknown): Schema
    array(item: Schema): Schema
    object(shape: Record<string, Schema>): Schema
    union(options: Schema[]): Schema
    record(value: Schema): Schema
    enum(values: unknown[]): Schema
    intersect(a: Schema, b: Schema): Schema
    [key: string]: any
  }
  const z: SchemaConstructor
  export default z
}
