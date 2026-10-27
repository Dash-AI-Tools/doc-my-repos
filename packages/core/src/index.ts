// Public entrypoint of @docmyrepos/core. Everything exported here is covered by semver;
// `@docmyrepos/core/internal/*` is not.
export { EXTENSION_API_VERSION } from "./contracts/version";
export {
  DEFAULT_TENANT,
  DEFAULT_TENANT_ID,
  TENANT_ID_PATTERN,
  isDefaultTenant,
  isTenantId,
  type TenantContext,
} from "./contracts/tenant";
export type { Role, User } from "./contracts/user";
export {
  ACTIONS,
  WORKSPACE,
  isAction,
  type Action,
  type Resource,
} from "./contracts/authorization";
export { defaultAuthorize } from "./contracts/authorize";
export { CORE_FEATURES, type CoreFeature, type Feature } from "./contracts/features";
export {
  EVENT_NAMES,
  EVENT_SCHEMA_VERSION,
  type DomainEvent,
  type DomainEventInput,
  type EventName,
  type EventPayloads,
  type SyncTrigger,
} from "./contracts/events";
export type { JsonValue } from "./contracts/json";
export {
  SLOT_NAMES,
  type AccountMenuItem,
  type AdminSectionItem,
  type BannerItem,
  type LinkItem,
  type SlotContribution,
  type SlotContributions,
  type SlotItems,
  type SlotName,
  type WorkspaceTabItem,
} from "./contracts/slots";
export {
  MIN_SCHEDULE_MS,
  PLUGIN_ID_PATTERN,
  PluginDefinitionError,
  definePlugin,
  pluginProblems,
  type AnyPluginDefinition,
  type HttpMethod,
  type PluginDefinition,
  type PluginJob,
  type PluginPage,
  type PluginPageProps,
  type PluginRoute,
  type PluginSchedule,
} from "./contracts/plugin";
