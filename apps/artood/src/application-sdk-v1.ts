/** Internal type-only draft. No runtime package, IPC protocol or HTTP service is supplied. */
export const APPLICATION_SDK_V1_MODULE = "@artoo/application";
export const APPLICATION_SDK_V1_SOURCE = `
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Scalar = null | boolean | number | string;
export interface Query { readonly kind: "query"; readonly table: string; readonly columns: readonly string[];
  readonly id?: string; readonly after?: string; readonly limit: number }
export type Mutation = { readonly kind: "insert"; readonly table: string; readonly id: string; readonly values: Readonly<Record<string, Scalar>> }
  | { readonly kind: "compare-and-set"; readonly table: string; readonly id: string; readonly expected_revision: number; readonly values: Readonly<Record<string, Scalar>> }
  | { readonly kind: "delete"; readonly table: string; readonly id: string; readonly expected_revision: number };
export type DataRequest = { readonly version: 1; readonly kind: "read"; readonly query: Query }
  | { readonly version: 1; readonly kind: "transaction"; readonly idempotency_key: string; readonly operations: readonly (Query | Mutation)[] };
export interface DataScope { readonly product_id: string; readonly data_generation: string;
  readonly service_generation: number; readonly artifact_digest: string }
export type OperationResult = { readonly kind: "rows"; readonly rows: readonly Readonly<Record<string, Scalar>>[] }
  | { readonly kind: "inserted" | "updated" | "deleted"; readonly id: string; readonly revision: number };
export interface DataReply { readonly version: 1; readonly request_digest: string; readonly replayed: boolean;
  readonly result: { readonly kind: "read"; readonly rows: readonly Readonly<Record<string, Scalar>>[]; readonly scope: DataScope }
    | { readonly kind: "committed"; readonly operations: readonly OperationResult[]; readonly scope: DataScope }
    | { readonly kind: "conflict"; readonly operation_index: number; readonly scope: DataScope } }
export interface ApplicationRequest { readonly request_id: string; readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string; readonly query: Readonly<Record<string, string>>; readonly body: Json }
export interface ApplicationContext { readonly data: { execute(request: DataRequest): Promise<DataReply> } }
export interface ApplicationResponse { readonly status: 200 | 201 | 204 | 400 | 404 | 409 | 422 | 500; readonly body: Json }
export type ApplicationHandler = (request: ApplicationRequest, context: ApplicationContext) => Promise<ApplicationResponse>;
`;
