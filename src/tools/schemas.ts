import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common Wrike API v4 types (from https://developers.wrike.com reference)
// ---------------------------------------------------------------------------

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
    folderId: z.string().regex(/^([A-Z0-9]){8,16}$/, 'Wrike folder API ID'),
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
    taskId: z.string().regex(/^([A-Z0-9]){8,16}$/, 'Wrike task API ID'),
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
    taskId: z.string().regex(/^([A-Z0-9]){8,16}$/),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const DeleteTaskSchema = z.object({ taskId: z.string() }).strict();

export const SearchSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
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
    spaceId: z.string().regex(/^([A-Z0-9]){16}$/),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const UpdateSpaceSchema = z
  .object({
    spaceId: z.string().regex(/^([A-Z0-9]){16}$/),
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
    spaceId: z.string().regex(/^([A-Z0-9]){16}$/).optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const GetFolderTreeSchema = z
  .object({
    folderId: z.string().regex(/^([A-Z0-9]){16}$/, 'Wrike folder API ID or Root API ID'),
  })
  .strict();

export const CreateFolderSchema = z
  .object({
    folderId: z.string().regex(/^([A-Z0-9]){16}$/, 'Wrike folder API ID'),
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
    folderId: z.string().regex(/^([A-Z0-9]){16}$/),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    addShareds: z.array(z.string()).optional(),
    removeShareds: z.array(z.string()).optional(),
    metadata: MetadataSchema,
    customFields: CustomFieldSchema,
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const DeleteFolderSchema = z.object({ folderId: z.string() }).strict();

// --- Comments ----------------------------------------------------------------

export const AddCommentSchema = z
  .object({
    targetType: z.enum(['tasks', 'folders']),
    targetId: z.string().regex(/^([A-Z0-9]){8,16}$/),
    text: z.string().min(1),
    plainText: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const ListCommentsSchema = z
  .object({
    targetType: z.enum(['tasks', 'folders']),
    targetId: z.string().regex(/^([A-Z0-9]){8,16}$/),
    fields: z.array(z.string()).optional(),
  })
  .strict();

// --- Timelogs ----------------------------------------------------------------

export const CreateTimelogSchema = z
  .object({
    taskId: z.string().regex(/^([A-Z0-9]){8,16}$/),
    comment: z.string().min(1),
    hours: z.number().positive(),
    trackedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-MM-dd'),
    categoryId: z.string().optional(),
    onBehalfOf: z.string().optional(),
    plainText: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const ListTimelogsSchema = z
  .object({
    folderId: z.string().optional(),
    contactIds: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    nextPageToken: z.string().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const UpdateTimelogSchema = z
  .object({
    timelogId: z.string().regex(/^([A-Z0-9]){8,16}$/),
    comment: z.string().optional(),
    hours: z.number().positive().optional(),
    trackedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    categoryId: z.string().optional(),
    onBehalfOf: z.string().optional(),
    plainText: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  })
  .strict();

export const DeleteTimelogSchema = z.object({ timelogId: z.string() }).strict();

// --- Attachments -------------------------------------------------------------

export const CreateAttachmentSchema = z
  .object({
    targetType: z.enum(['tasks', 'folders']),
    targetId: z.string().regex(/^([A-Z0-9]){8,16}$/),
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
    targetId: z.string().regex(/^([A-Z0-9]){8,16}$/),
    /** Wrike names this `withUrls` (plural); a `url` valid for 24h is added to each attachment. */
    withUrls: z.boolean().optional(),
    /** Include previous versions of each attachment. */
    versions: z.boolean().optional(),
  })
  .strict();

export const GetAttachmentSchema = z
  .object({
    attachmentId: z.string().regex(/^([A-Z0-9]){16}$/),
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

export const DeleteAttachmentSchema = z.object({ attachmentId: z.string() }).strict();

export const GetTimelogsSchema = ListTimelogsSchema;