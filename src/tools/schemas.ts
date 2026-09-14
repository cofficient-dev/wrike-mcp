import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common Wrike API v4 types (from https://developers.wrike.com reference)
// ---------------------------------------------------------------------------

/**
 * A Wrike entity id (folder, task, space, attachment, timelog, contact, ...).
 *
 * Wrike documents no pattern for these — the OpenAPI definitions type them as
 * plain strings — so a strict client-side shape was never justified by the
 * API contract. This account mints legacy uppercase ids (`IEACK5SYI7777777`,
 * 16 chars; `KUABHKOF`, 8 chars) and newer ids that are base64url-encoded
 * (alphabet `A-Z a-z 0-9 - _`), e.g. `MQAAAAEPpWtv`.
 *
 * History: fb52f2e ("fix(schemas): accept new-format mixed-case Wrike ids")
 * widened this pattern from `^[A-Z0-9]{8,16}$` to `^[A-Za-z0-9]+$` after new
 * ids started appearing, but only added the letter case — it missed the
 * other two characters of the same base64url alphabet, `-` and `_`. That
 * left a steady fraction of new ids (roughly one in ten, by the account's
 * own numbers) rejected by this server's own validation before ever reaching
 * Wrike, e.g. `MAAAAAEPp_4d`, observed live on a task returned by this same
 * server and then unreachable through it, including for `delete_task`. `-`
 * and `_` are added now on that same evidence: they complete the base64url
 * alphabet and one of them is a real production id.
 *
 * The character set stays closed rather than becoming permissive: these ids
 * are frequently interpolated into a Wrike API URL path, and this schema is
 * what keeps path separators and traversal sequences out of that path. The
 * rule for widening it is to complete an alphabet already evidenced by at
 * least one genuinely observed id, not to add a character because it might
 * plausibly appear: `-` and `_` went in together because `_` was observed
 * live and both are part of the same documented base64url alphabet, not
 * because either was guessed at. This is the second time this exact regex
 * has needed correcting for missing part of a documented alphabet, and a
 * third time should not repeat the pattern of adding characters piecemeal
 * instead of reasoning about the whole alphabet — but "the whole alphabet"
 * means base64url specifically, not every character that looks adjacent to
 * it: base64 padding (`=`) is not part of base64url and must stay rejected
 * even though it sits right next to the characters just added.
 *
 * The 128-char ceiling is a sanity bound, not a claim about the format: it
 * stops an arbitrarily long string being pushed through as a path segment,
 * while leaving room far beyond anything Wrike has been seen to mint (longest
 * observed is 16). Deliberately generous — the failure this schema exists to
 * fix was a bound set too tightly around the ids that happened to be visible
 * at the time, and a cap of, say, 64 would repeat that mistake in miniature
 * if the format grows again.
 *
 * The pattern requires at least one alphanumeric character somewhere in the
 * string (the leading lookahead): `-` and `_` are valid Wrike id characters
 * but are not by themselves an id, and without this an all-symbol string
 * (`____`, a bare `-`) would pass length and character-class checks alone.
 * `.` and `/` stay outside the class entirely, so path traversal is excluded
 * regardless of this lookahead.
 */
export const WrikeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?=.*[A-Za-z0-9])[A-Za-z0-9_-]+$/, 'Wrike API ID');

export const TaskStatusSchema = z.enum(['Active', 'Deferred', 'Completed', 'Cancelled']);
export const TaskImportanceSchema = z.enum(['High', 'Low', 'Normal']);
export const TaskDatesTypeSchema = z.enum(['Milestone', 'Backlog', 'Planned']);
export const EffortModeSchema = z.enum(['Basic', 'Flexible', 'Daily']);
export const BillingTypeSchema = z.enum(['Draft', 'Quote', 'Invoice', 'Paid']);

/** Task dates: full Wrike TaskDates object. */
export const TaskDatesSchema = z
  .object({
    type: TaskDatesTypeSchema.optional(),
    start: z.string().optional(),
    due: z.string().optional(),
    duration: z.number().min(0).max(1_800_000).optional(),
    workOnWeekends: z.boolean().optional(),
  })
  .strict()
  .refine(
    (d) => d.due !== undefined || d.type !== 'Planned' || d.start === undefined || d.duration !== undefined,
    'Planned tasks with a start date require a due date or duration'
  );

/** Effort allocation: full Wrike TaskEffort object. */
export const ResponsibleAllocationSchema = z
  .object({
    id: z.string(),
    allocationPercentage: z.number().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .strict();

export const TaskEffortSchema = z
  .object({
    mode: EffortModeSchema,
    totalEffort: z.number().optional(),
    allocatedEffort: z.number().optional(),
    dailyAllocationPercentage: z.number().optional(),
    responsibleAllocation: z.array(ResponsibleAllocationSchema).optional(),
  })
  .strict();

export const MetadataSchema = z
  .array(
    z
      .object({
        key: z.string(),
        value: z.string(),
      })
      .strict()
  )
  .optional();

export const CustomFieldSchema = z
  .array(
    z
      .object({
        id: z.string(),
        value: z.string(),
      })
      .strict()
  )
  .optional();

export const TaskCreateSchema = z
  .object({
    folderId: WrikeIdSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    status: TaskStatusSchema.optional(),
    importance: TaskImportanceSchema.optional(),
    dates: TaskDatesSchema.optional(),
    shareds: z.array(z.string()).optional(),
    parents: z.array(z.string()).optional(),
    responsibles: z.array(z.string()).optional(),
    responsiblePlaceholders: z.array(z.string()).optional(),
    followers: z.array(z.string()).optional(),
    follow: z.boolean().optional(),
    priorityBefore: z.string().optional(),
    priorityAfter: z.string().optional(),
    superTasks: z.array(z.string()).optional(),
    metadata: MetadataSchema,
    customFields: CustomFieldSchema,
    customStatus: z.string().optional(),
    effortAllocation: TaskEffortSchema.optional(),
    billingType: BillingTypeSchema.optional(),
    withInvitations: z.boolean().optional(),
    customItemTypeId: z.string().optional(),
    plainTextCustomFields: z.array(z.object({ id: z.string(), value: z.string() }).strict()).optional(),
    workScheduleId: z.string().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const TaskUpdateSchema = z
  .object({
    taskId: WrikeIdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: TaskStatusSchema.optional(),
    importance: TaskImportanceSchema.optional(),
    dates: TaskDatesSchema.optional(),
    addParents: z.array(z.string()).optional(),
    removeParents: z.array(z.string()).optional(),
    addShareds: z.array(z.string()).optional(),
    removeShareds: z.array(z.string()).optional(),
    addResponsibles: z.array(z.string()).optional(),
    removeResponsibles: z.array(z.string()).optional(),
    addResponsiblePlaceholders: z.array(z.string()).optional(),
    removeResponsiblePlaceholders: z.array(z.string()).optional(),
    addFollowers: z.array(z.string()).optional(),
    follow: z.boolean().optional(),
    priorityBefore: z.string().optional(),
    priorityAfter: z.string().optional(),
    addSuperTasks: z.array(z.string()).optional(),
    removeSuperTasks: z.array(z.string()).optional(),
    metadata: MetadataSchema,
    customFields: CustomFieldSchema,
    customStatus: z.string().optional(),
    restore: z.boolean().optional(),
    effortAllocation: TaskEffortSchema.optional(),
    setResponsibleAllocation: z.array(ResponsibleAllocationSchema).optional(),
    billingType: BillingTypeSchema.optional(),
    withInvitations: z.boolean().optional(),
    convertToCustomItemType: z.string().optional(),
    plainTextCustomFields: z.array(z.object({ id: z.string(), value: z.string() }).strict()).optional(),
    workScheduleId: z.string().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const ListTasksSchema = z
  .object({
    descendants: z.boolean().optional(),
    title: z.string().optional(),
    status: TaskStatusSchema.optional(),
    importance: TaskImportanceSchema.optional(),
    startDate: z.string().optional(),
    dueDate: z.string().optional(),
    scheduledDate: z.string().optional(),
    createdDate: z.string().optional(),
    updatedDate: z.string().optional(),
    completedDate: z.string().optional(),
    authors: z.array(z.string()).optional(),
    responsibles: z.array(z.string()).optional(),
    responsiblePlaceholders: z.array(z.string()).optional(),
    permalink: z.string().optional(),
    type: TaskDatesTypeSchema.optional(),
    subTasks: z.boolean().optional(),
    pageSize: z.number().int().positive().optional(),
    nextPageToken: z.string().optional(),
    customField: z.object({ id: z.string(), value: z.string() }).strict().optional(),
    customStatuses: z.array(z.string()).optional(),
    billingTypes: z.array(BillingTypeSchema).optional(),
    customItemTypes: z.array(z.string()).optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const GetTaskSchema = z
  .object({
    taskId: WrikeIdSchema,
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const DeleteTaskSchema = z.object({ taskId: WrikeIdSchema }).strict();

/** Wrike has no unified search endpoint; `search` fans out to one GET per target. */
export const SearchTargetSchema = z.enum(['tasks', 'folders', 'contacts']);

export const SearchSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
    targets: z.array(SearchTargetSchema).min(1).optional(),
  })
  .strict();

export const WhoamiSchema = z.object({}).strict();

export const GetAccountSchema = z.object({}).strict();

// --- Spaces -----------------------------------------------------------------

export const ListSpacesSchema = z
  .object({
    withArchived: z.boolean().optional(),
    userIsMember: z.boolean().optional(),
    withInvitations: z.boolean().optional(),
    title: z.string().optional(),
    accessTypes: z.array(z.string()).optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const GetSpaceSchema = z
  .object({
    spaceId: WrikeIdSchema,
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const UpdateSpaceSchema = z
  .object({
    spaceId: WrikeIdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    accessType: z.enum(['Private', 'Public']).optional(),
    members: z.array(z.string()).optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

// --- Folders ----------------------------------------------------------------

export const ListFoldersSchema = z
  .object({
    spaceId: WrikeIdSchema.optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const GetFolderTreeSchema = z
  .object({
    folderId: WrikeIdSchema,
  })
  .strict();

export const CreateFolderSchema = z
  .object({
    folderId: WrikeIdSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    shareds: z.array(z.string()).optional(),
    metadata: MetadataSchema,
    customFields: CustomFieldSchema,
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const UpdateFolderSchema = z
  .object({
    folderId: WrikeIdSchema,
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    addShareds: z.array(z.string()).optional(),
    removeShareds: z.array(z.string()).optional(),
    metadata: MetadataSchema,
    customFields: CustomFieldSchema,
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const DeleteFolderSchema = z.object({ folderId: WrikeIdSchema }).strict();

// --- Comments ----------------------------------------------------------------

export const AddCommentSchema = z
  .object({
    targetType: z.enum(['tasks', 'folders']),
    targetId: WrikeIdSchema,
    text: z.string().min(1),
    plainText: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const ListCommentsSchema = z
  .object({
    targetType: z.enum(['tasks', 'folders']),
    targetId: WrikeIdSchema,
    fields: z.array(z.string()).optional(),
  })
  .strict();

// --- Timelogs ----------------------------------------------------------------

export const CreateTimelogSchema = z
  .object({
    taskId: WrikeIdSchema,
    comment: z.string().min(1),
    hours: z.number().positive(),
    trackedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd'),
    categoryId: z.string().optional(),
    onBehalfOf: z.string().optional(),
    plainText: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

/** Wrike `InstantRange` format: `yyyy-MM-dd'T'HH:mm:ss'Z'` — the trailing `Z` is required. */
const INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * `createdDate` / `updatedDate` filter shape (Wrike `InstantRange`: full
 * timestamp, no exact-match shorthand — set `start` and `end` to the same
 * value for that). See https://developers.wrike.com/api/v4/timelogs/.
 *
 * Both fields are optional individually (a range can be open-ended), but at
 * least one must be present: a range naming no bound is meaningless input
 * that would otherwise reach Wrike as a silent no-op filter. `.refine()` is
 * safe on this schema because it is nested (used only inside
 * `ListTimelogsSchema`'s fields), not a top-level tool input schema — see the
 * note above `ListTimelogsSchema` for why that distinction matters.
 */
export const InstantRangeSchema = z
  .object({
    start: z.string().regex(INSTANT_REGEX, "yyyy-MM-dd'T'HH:mm:ss'Z'").optional(),
    end: z.string().regex(INSTANT_REGEX, "yyyy-MM-dd'T'HH:mm:ss'Z'").optional(),
  })
  .strict()
  .refine((r) => r.start !== undefined || r.end !== undefined, 'at least one of start or end is required');

/** Wrike `LocalDateTimeRange` format: `yyyy-MM-dd'T'HH:mm:ss`, time part optional. */
const LOCAL_DATE_TIME_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;

/**
 * `trackedDate` filter shape (Wrike `LocalDateTimeRange`: calendar
 * date/time; `equal` is the exact-match shorthand, distinct from
 * `InstantRangeSchema` above). See https://developers.wrike.com/api/v4/timelogs/.
 *
 * At least one field must be present, for the same reason as
 * `InstantRangeSchema` above; `.refine()` is likewise safe here because this
 * schema is nested, not a top-level tool input schema.
 */
export const LocalDateTimeRangeSchema = z
  .object({
    equal: z.string().regex(LOCAL_DATE_TIME_REGEX, "yyyy-MM-dd or yyyy-MM-dd'T'HH:mm:ss").optional(),
    start: z.string().regex(LOCAL_DATE_TIME_REGEX, "yyyy-MM-dd or yyyy-MM-dd'T'HH:mm:ss").optional(),
    end: z.string().regex(LOCAL_DATE_TIME_REGEX, "yyyy-MM-dd or yyyy-MM-dd'T'HH:mm:ss").optional(),
  })
  .strict()
  .refine(
    (r) => r.equal !== undefined || r.start !== undefined || r.end !== undefined,
    'at least one of equal, start, or end is required'
  );

export const TimelogExportStatusSchema = z.enum(['NotExported', 'Exported', 'ReadyForExport']);
export const TimelogBillingTypeSchema = z.enum(['Billable', 'NonBillable']);
export const TimelogApprovalStatusSchema = z.enum([
  'Draft',
  'NotRequired',
  'Approved',
  'Rejected',
  'Cancelled',
  'Pending',
]);

/**
 * Filters for `GET /timelogs` (and the folder-/task-scoped variants this
 * tool routes to). A live sweep found the previous shape — `contactIds`,
 * `startDate`, `endDate` — all rejected live with
 * "400 (invalid_request): Parameter '<name>' is not allowed", and an
 * unfiltered call returning the account's entire timelog history (~257,000
 * lines) in one response, because Wrike's docs are explicit that omitting
 * `pageSize`/`limit` returns everything in a single response. This schema
 * keeps only the parameters GET /timelogs documents; `folderId`/`taskId` are
 * not among them but are accepted here because the tool handler uses them to
 * route to `/folders/{folderId}/timelogs` / `/tasks/{taskId}/timelogs`
 * instead of adding them as query params on `/timelogs` itself.
 */
export const ListTimelogsSchema = z
  .object({
    // Path-interpolated by the handler, so they get the same guard as every
    // other id here: WrikeIdSchema keeps separators and traversal sequences
    // out of an id that becomes part of a request path.
    folderId: WrikeIdSchema.optional(),
    taskId: WrikeIdSchema.optional(),
    createdDate: InstantRangeSchema.optional(),
    updatedDate: InstantRangeSchema.optional(),
    trackedDate: LocalDateTimeRangeSchema.optional(),
    me: z.boolean().optional(),
    descendants: z.boolean().optional(),
    plainText: z.boolean().optional(),
    timelogCategories: z.array(z.string()).optional(),
    exportStatuses: z.array(TimelogExportStatusSchema).optional(),
    billingTypes: z.array(TimelogBillingTypeSchema).optional(),
    approvalStatuses: z.array(TimelogApprovalStatusSchema).optional(),
    // Bounds taken from Wrike's GET /timelogs reference, not invented:
    // pageSize is documented as 1-1000, so it is capped there. `limit` is
    // documented only as "Total record limit" with no ceiling, so none is
    // imposed — a .max() here would be a guess, and guessing at the API
    // contract is what produced the bugs this file is being fixed for.
    // Response size is bounded by the default pageSize the handler sends
    // (see list_timelogs), which is what actually governs a single response;
    // limit only caps the total across pages.
    limit: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(1000).optional(),
    nextPageToken: z
      .string()
      .describe(
        'Pagination token from a previous response. Repeat folderId or taskId on every ' +
          'page: endpoint selection is keyed on those, not on the token, so a token sent ' +
          'without the scoping id is served from the account-wide endpoint.'
      )
      .optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();
// folderId and taskId select different endpoints, so passing both is a
// contradiction rather than a combination — the handler rejects it (see
// list_timelogs). That check cannot live here as a .refine(): the MCP SDK
// registers a tool's input schema by reading its .shape, so a top-level
// schema must stay a plain ZodObject. .refine() returns a ZodEffects wrapper
// and every tool registration then fails with "expected a zod object schema".
// (Nested schemas like TaskDatesSchema can use .refine() freely.)

export const UpdateTimelogSchema = z
  .object({
    timelogId: WrikeIdSchema,
    comment: z.string().optional(),
    hours: z.number().positive().optional(),
    trackedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    categoryId: z.string().optional(),
    onBehalfOf: z.string().optional(),
    plainText: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const DeleteTimelogSchema = z.object({ timelogId: WrikeIdSchema }).strict();

// --- Attachments -------------------------------------------------------------

export const CreateAttachmentSchema = z
  .object({
    targetType: z.enum(['tasks', 'folders']),
    targetId: WrikeIdSchema,
    /** File name. */
    filename: z.string().min(1),
    /** Base64-encoded file content. */
    content: z.string().min(1),
    /** MIME type, e.g. application/pdf. */
    contentType: z.string().default('application/octet-stream'),
    comment: z.string().optional(),
    version: z.string().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const ListAttachmentsSchema = z
  .object({
    targetType: z.enum(['tasks', 'folders']),
    targetId: WrikeIdSchema,
    /** Wrike names this `withUrls` (plural); a `url` valid for 24h is added to each attachment. */
    withUrls: z.boolean().optional(),
    /** Include previous versions of each attachment. */
    versions: z.boolean().optional(),
  })
  .strict();

export const GetAttachmentSchema = z
  .object({
    attachmentId: WrikeIdSchema,
    /**
     * What to return. Defaults to `'metadata'` when omitted.
     *
     * - `'metadata'` — attachment metadata only, no file bytes.
     * - `'url'` — a short-lived, single-attachment signed URL on this
     *   server; a browser opening it downloads the file directly. This is
     *   the mode to use to hand a file to a *person*. Requires this
     *   server's `PUBLIC_BASE_URL` to be configured; makes no Wrike API call.
     * - `'download'` — the file content itself, base64-encoded, inside the
     *   tool result (uses `GET /attachments/{id}/download`, the only Wrike
     *   endpoint that yields bytes). **Never use this to relay a file to a
     *   person in a chat reply** — an LLM cannot reproduce a long base64
     *   string verbatim, and a corrupted reproduction is a silent, not a
     *   loud, failure. Only use it when a program will consume `content`
     *   directly.
     */
    mode: z.enum(['metadata', 'download', 'url']).optional(),
    /** Include previous versions in the metadata response. */
    versions: z.boolean().optional(),
  })
  .strict();

export const DeleteAttachmentSchema = z.object({ attachmentId: WrikeIdSchema }).strict();

export const GetTimelogsSchema = ListTimelogsSchema;