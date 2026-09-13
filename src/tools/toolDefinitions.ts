import type { WrikeClient } from '../wrikeClient.js';
import { BinaryTooLargeError } from '../wrikeClient.js';
import * as S from './schemas.js';
import { z } from 'zod';

type SearchTarget = z.infer<typeof S.SearchTargetSchema>;

/**
 * Wrike API v4 has no `/search` endpoint — calling one returns
 * `400 method_not_found`. Each target below is a real, separately-documented
 * endpoint with its own filter parameter name and its own (undocumented, for
 * contacts) matching behaviour; do not collapse these back into one path.
 */
const SEARCH_TARGETS: Record<SearchTarget, { path: string; filterParam: 'title' | 'name' }> = {
    tasks: { path: '/tasks', filterParam: 'title' },
    folders: { path: '/folders', filterParam: 'title' },
    contacts: { path: '/contacts', filterParam: 'name' },
};

/**
 * Queries one search target and applies `limit` uniformly.
 *
 * `limit` is passed natively where the endpoint documents support for it
 * (`limit` on /tasks, `pageSize` on /folders — /folders does not document
 * `limit` itself) and is otherwise left off the request (/contacts documents
 * neither). The client-side slice afterwards makes the three behave the same
 * from the caller's point of view regardless of that inconsistency.
 */
async function searchTarget(
    client: WrikeClient,
    target: SearchTarget,
    q: string,
    limit: number | undefined
): Promise<unknown[]> {
    const { path, filterParam } = SEARCH_TARGETS[target];
    const params: Record<string, unknown> = { [filterParam]: q };
    if (limit !== undefined) {
        if (target === 'tasks') params.limit = limit;
        else if (target === 'folders') params.pageSize = limit;
    }
    const res = await client.get<unknown[]>(path, query(params));
    const data = Array.isArray(res.data) ? res.data : [];
    return limit !== undefined ? data.slice(0, limit) : data;
}

type AnySchema = z.ZodTypeAny;

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: AnySchema;
    /** Handler receives a WrikeClient bound to the requesting user's credentials. */
    handler: (client: WrikeClient, input: unknown) => Promise<unknown>;
}

function def<T extends AnySchema>(
    name: string,
    description: string,
    inputSchema: T,
    handler: (client: WrikeClient, input: z.infer<T>) => Promise<unknown>
): ToolDefinition {
    return {
        name,
        description,
        inputSchema,
        handler: async (client, raw) => {
            const parsed = inputSchema.parse(raw);
            return handler(client, parsed);
        },
    };
}

/**
 * Ceiling on an attachment returned inline. Base64 inflates by ~33% and the
 * result is carried in the MCP response, so a large file would swamp the
 * client. Past this, list_attachments + withUrls hands back a 24h URL instead.
 */
const MAX_INLINE_DOWNLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Default `pageSize` sent to GET /timelogs (and its folder/task-scoped
 * variants) when the caller supplies neither `pageSize` nor `limit`. Wrike's
 * docs say plainly that omitting both returns every matching timelog in one
 * response — a live sweep observed ~257,000 lines from a single unfiltered
 * call on this account. Chosen as a defensible middle ground: bounded well
 * below Wrike's documented pageSize ceiling (1000), but generous enough that
 * routine use rarely needs a second page.
 */
const DEFAULT_TIMELOG_PAGE_SIZE = 200;

/** Serializes array/object query values the Wrike API expects (JSON in query string). */
function query(params: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
    const out: Record<string, string | number | boolean | undefined> = {};
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) out[k] = JSON.stringify(v);
        else if (typeof v === 'object' && v !== null) out[k] = JSON.stringify(v);
        else out[k] = v as string | number | boolean;
    }
    return out;
}

export function buildTools(): ToolDefinition[] {
    return [
        // ------------------------------------------------------------------ core
        def('whoami', 'Get the authenticated Wrike user (contacts?me=true).', S.WhoamiSchema, (c) =>
            c.get('/contacts', query({ me: 'true' }))
        ),
        def('get_account', 'Get the Wrike account of the authenticated user.', S.GetAccountSchema, (c) =>
            c.get('/account')
        ),

        // ---------------------------------------------------------------- spaces
        def('list_spaces', 'List Wrike spaces with optional filters.', S.ListSpacesSchema, (c, p) =>
            c.get('/spaces', query(p))
        ),
        def('get_space', 'Get a Wrike space by ID.', S.GetSpaceSchema, (c, p) =>
            c.get(`/spaces/${p.spaceId}`, query({ fields: p.fields }))
        ),
        def('update_space', 'Update a Wrike space (title, description, access type, members).', S.UpdateSpaceSchema, (c, p) =>
            c.put(`/spaces/${p.spaceId}`, query({ fields: p.fields }), {
                title: p.title,
                description: p.description,
                accessType: p.accessType,
                members: p.members,
            })
        ),

        // ---------------------------------------------------------------- folders
        def('list_folders', 'List folders, optionally scoped to a space.', S.ListFoldersSchema, (c, p) =>
            p.spaceId ? c.get(`/spaces/${p.spaceId}/folders`, query({ fields: p.fields })) : c.get('/folders')
        ),
        // GET /folders/{folderId} does not accept `descendants` — a live
        // sweep found every call here returning
        // "400 (invalid_request): Parameter 'descendants' is not allowed",
        // meaning this tool never worked. GET /folders/{folderId}/folders is
        // the documented subfolder-tree endpoint and does accept it
        // (boolean, default true, "Adds all descendant folders to search
        // scope") — see https://developers.wrike.com/reference/getfolderssinglefolders.md
        def('get_folder_tree', 'Get the folder/project tree below a folder (use Root API ID for account tree).', S.GetFolderTreeSchema, (c, p) =>
            c.get(`/folders/${p.folderId}/folders`, { descendants: 'true' })
        ),
        def('create_folder', 'Create a folder/project under a parent folder.', S.CreateFolderSchema, (c, p) =>
            c.post(`/folders/${p.folderId}/folders`, query({ fields: p.fields }), {
                title: p.title,
                description: p.description,
                shareds: p.shareds,
                metadata: p.metadata,
                customFields: p.customFields,
            })
        ),
        def('update_folder', 'Update a folder/project.', S.UpdateFolderSchema, (c, p) =>
            c.put(`/folders/${p.folderId}`, query({ fields: p.fields }), {
                title: p.title,
                description: p.description,
                addShareds: p.addShareds,
                removeShareds: p.removeShareds,
                metadata: p.metadata,
                customFields: p.customFields,
            })
        ),
        def('delete_folder', 'Delete a folder (moves to Recycle Bin).', S.DeleteFolderSchema, (c, p) =>
            c.delete(`/folders/${p.folderId}`)
        ),

        // ----------------------------------------------------------------- tasks
        def(
            'create_task',
            'Create a Wrike task with full object support: dates (start/due/duration/workOnWeekends/type), effort allocation (mode, totalEffort, allocatedEffort, dailyAllocationPercentage, responsibleAllocation), custom fields, metadata, responsibles, followers, priority, billing type, custom status.',
            S.TaskCreateSchema,
            (c, p) => {
                const { folderId, ...rest } = p;
                return c.post(`/folders/${folderId}/tasks`, query({ fields: p.fields }), rest);
            }
        ),
        def(
            'update_task',
            'Update a Wrike task: dates, effort allocation, add/remove responsibles, followers, parents, shareds, superTasks, custom fields, restore, convert to custom item type.',
            S.TaskUpdateSchema,
            (c, p) => {
                const { taskId, ...rest } = p;
                return c.put(`/tasks/${taskId}`, query({ fields: p.fields }), rest);
            }
        ),
        def('list_tasks', 'List/query tasks with full filter support (dates, status, authors, custom fields, pagination).', S.ListTasksSchema, (c, p) =>
            c.get('/tasks', query(p))
        ),
        def('get_task', 'Get a task by ID.', S.GetTaskSchema, (c, p) =>
            c.get(`/tasks/${p.taskId}`, query({ fields: p.fields }))
        ),
        def('delete_task', 'Delete a task (moves to Recycle Bin).', S.DeleteTaskSchema, (c, p) =>
            c.delete(`/tasks/${p.taskId}`)
        ),
        def(
            'search',
            "Search tasks, folders, and contacts by query. Wrike API v4 has no unified search " +
            "endpoint, so this fans out to GET /tasks and GET /folders (title, contains-match) and " +
            "GET /contacts (name filter — Wrike does not document its matching semantics; don't rely " +
            "on exact behaviour there). `limit` applies per target, not to the combined total — " +
            "requesting limit: 10 can return up to 10 tasks AND up to 10 folders AND up to 10 " +
            "contacts. Narrow `targets` to skip endpoints you don't need. If one target's endpoint " +
            "fails (e.g. contacts is restricted on this account), the others are still returned; the " +
            "failure is named in `errors` instead of failing the whole call.",
            S.SearchSchema,
            async (c, p) => {
                const ALL_TARGETS: readonly SearchTarget[] = ['tasks', 'folders', 'contacts'];
                // Deduplicated: each entry becomes its own GET, so a repeated
                // target would fire identical concurrent requests at one
                // endpoint and report a single outage once per duplicate in
                // `errors`. `targets` is a set in meaning, so treat it as one.
                // This also bounds the fan-out at three without a separate
                // length cap, since there are only three valid values.
                const targets = Array.from(new Set(p.targets ?? ALL_TARGETS));

                // Each promise carries its own target through to settlement (as the
                // fulfilled value, or folded into the rejection) so results can be
                // matched back up without indexing parallel arrays.
                const settled = await Promise.allSettled(
                    targets.map((target) =>
                        searchTarget(c, target, p.query, p.limit).then(
                            (data) => ({ target, data }),
                            (err) => {
                                throw { target, error: err instanceof Error ? err.message : String(err) };
                            }
                        )
                    )
                );

                // This tool merges three independent resources into one result, so
                // unlike the single-object tools elsewhere in this file it cannot
                // hand back a raw WrikeResponse envelope — there is no single `kind`
                // that fits tasks, folders and contacts at once. A purpose-built
                // shape is the correct departure from that convention here.
                const result: {
                    query: string;
                    tasks?: unknown[];
                    folders?: unknown[];
                    contacts?: unknown[];
                    errors?: { target: SearchTarget; error: string }[];
                } = { query: p.query };
                const errors: { target: SearchTarget; error: string }[] = [];

                for (const s of settled) {
                    if (s.status === 'fulfilled') {
                        result[s.value.target] = s.value.data;
                    } else {
                        errors.push(s.reason as { target: SearchTarget; error: string });
                    }
                }
                // Partial failure degrades gracefully, but total failure must not:
                // { query, errors } with no results is success-shaped and reads at
                // the call site exactly like a search that legitimately found
                // nothing. An expired token or a Wrike outage would then surface to
                // the user as "no results", which is worse than an error. Throw only
                // when every requested target failed, so genuine partial outages keep
                // returning what they did find.
                if (errors.length === settled.length) {
                    throw new Error(
                        `Search failed for every target (${errors.map((e) => `${e.target}: ${e.error}`).join('; ')})`
                    );
                }
                if (errors.length > 0) result.errors = errors;

                return result;
            }
        ),

        // -------------------------------------------------------------- comments
        def('add_comment', 'Add a comment to a task or folder.', S.AddCommentSchema, (c, p) =>
            c.post(`/${p.targetType}/${p.targetId}/comments`, query({ fields: p.fields }), {
                text: p.text,
                plainText: p.plainText,
            })
        ),
        def('list_comments', 'List comments on a task or folder.', S.ListCommentsSchema, (c, p) =>
            c.get(`/${p.targetType}/${p.targetId}/comments`, query({ fields: p.fields }))
        ),

        // -------------------------------------------------------------- timelogs
        def('create_timelog', 'Create a timelog record on a task (comment, hours, trackedDate; optional categoryId, onBehalfOf).', S.CreateTimelogSchema, (c, p) => {
            const { taskId, ...rest } = p;
            return c.post(`/tasks/${taskId}/timelogs`, query({ fields: rest.fields }), rest);
        }),
        def(
            'list_timelogs',
            `List timelogs with documented filters (createdDate/updatedDate/trackedDate ranges, ` +
                `timelogCategories, exportStatuses, billingTypes, approvalStatuses, me, descendants). ` +
                `Results are paginated: defaults to pageSize ${DEFAULT_TIMELOG_PAGE_SIZE} whenever pageSize ` +
                `is not given (Wrike returns the entire account's timelog history in one response ` +
                `otherwise), use nextPageToken to continue. limit caps the total across pages and does ` +
                `not bound a single response. folderId/taskId route to that folder's or task's timelogs ` +
                `instead of filtering the account-wide endpoint. Repeat folderId/taskId on every page ` +
                `when paging with nextPageToken: the scoping id, not the token, selects the endpoint.`,
            S.ListTimelogsSchema,
            (c, p) => {
                const { folderId, taskId, limit, pageSize, ...rest } = p;
                // Contradiction, not a combination: they select different
                // endpoints. Silently preferring one would return
                // folder-scoped results that read as task-scoped — wrong data
                // presented as if it were right. Enforced here rather than in
                // the schema because a top-level tool schema must stay a plain
                // ZodObject for the MCP SDK to register it.
                if (folderId !== undefined && taskId !== undefined) {
                    throw new Error(
                        'Pass folderId or taskId, not both — they select different endpoints'
                    );
                }
                // Wrike's own docs are explicit: omit pageSize and every matching
                // timelog comes back in a single response — a live sweep saw
                // ~257,000 lines from one unfiltered call.
                //
                // Only pageSize bounds the size of a response; `limit` caps the
                // total across pages and does nothing to how much arrives at
                // once. So the default is keyed on pageSize alone: keying it on
                // "neither given" meant `limit: 100000` suppressed the default
                // and reproduced the very problem this bounds. An explicit
                // pageSize is passed through untouched.
                // Not applied to a continuation: nextPageToken resumes a query
                // that was already paged, and Wrike's docs say pageSize "can be
                // omitted in this case" — the token carries that context.
                // Injecting a default there would silently re-page a caller who
                // started with a different size, so the default only bounds an
                // initial request, which is the unbounded one it exists for.
                const bounded =
                    pageSize === undefined && rest.nextPageToken === undefined
                        ? DEFAULT_TIMELOG_PAGE_SIZE
                        : pageSize;
                const params = query({ ...rest, limit, pageSize: bounded });
                // Routing is keyed on folderId/taskId alone, not on
                // nextPageToken — Wrike's docs don't say whether a
                // continuation token itself carries endpoint scope (the
                // /timelogs reference documents only the account-wide
                // endpoint, not the folder/task variants), so that isn't
                // assumed here. A caller who pages a scoped query must repeat
                // folderId/taskId on every page or a token-only follow-up
                // falls through to the account-wide endpoint below. That
                // requirement is stated in the tool and schema descriptions
                // rather than enforced here, since enforcing it would mean
                // inventing a contract Wrike doesn't document.
                if (folderId) return c.get(`/folders/${folderId}/timelogs`, params);
                if (taskId) return c.get(`/tasks/${taskId}/timelogs`, params);
                return c.get('/timelogs', params);
            }
        ),
        def('update_timelog', 'Update a timelog record.', S.UpdateTimelogSchema, (c, p) => {
            const { timelogId, ...rest } = p;
            return c.put(`/timelogs/${timelogId}`, query({ fields: rest.fields }), rest);
        }),
        def('delete_timelog', 'Delete a timelog record.', S.DeleteTimelogSchema, (c, p) =>
            c.delete(`/timelogs/${p.timelogId}`)
        ),

        // ---------------------------------------------------------- attachments
        def(
            'create_attachment',
            'Upload a file attachment to a task or folder. Content is base64 in the request; it is streamed to Wrike and never persisted by this server.',
            S.CreateAttachmentSchema,
            (c, p) => {
                const buffer = Buffer.from(p.content, 'base64');
                return c.upload(
                    `/${p.targetType}/${p.targetId}/attachments`,
                    {
                        name: p.filename,
                        contentType: p.contentType,
                        data: buffer,
                    },
                    {
                        ...(p.comment !== undefined ? { comment: p.comment } : {}),
                        ...(p.version !== undefined ? { version: p.version } : {}),
                        ...(p.fields ? { fields: JSON.stringify(p.fields) } : {}),
                    }
                );
            }
        ),
        def(
            'list_attachments',
            "List attachments on a task or folder. Set withUrls for a Wrike-hosted download URL valid 24h. " +
            "To hand a single attachment to a person, prefer get_attachment with mode: 'url' instead " +
            "(this server's own short-lived link, no Wrike round trip to mint).",
            S.ListAttachmentsSchema,
            (c, p) =>
                c.get(
                    `/${p.targetType}/${p.targetId}/attachments`,
                    // Wrike's parameter is `withUrls` (plural); `fields` is not
                    // supported on this endpoint and was rejected when sent.
                    query({ withUrls: p.withUrls, versions: p.versions })
                )
        ),
        def(
            'get_attachment',
            "Get an attachment by ID. mode: 'metadata' (default) returns metadata only. " +
            "mode: 'url' returns a short-lived signed download link for a person to open in a browser " +
            "(needs PUBLIC_BASE_URL; makes no Wrike API call). mode: 'download' returns the file content " +
            "base64-encoded for a program to consume directly — never use it to relay a file to a person " +
            "in a chat reply.",
            S.GetAttachmentSchema,
            async (c, p) => {
                const mode = p.mode ?? 'metadata';
                if (mode === 'metadata') {
                    // GET /attachments/{ids} takes a comma-separated list and
                    // supports only `versions` — no URL-bearing parameter.
                    return c.get(`/attachments/${p.attachmentId}`, query({ versions: p.versions }));
                }
                if (mode === 'url') {
                    // Signed locally, so this never touches the Wrike API.
                    const { url, expiresAt } = c.signedDownloadUrl(p.attachmentId);
                    return { attachmentId: p.attachmentId, url, expiresAt };
                }
                // mode === 'download'. The byte budget is enforced inside
                // getBinary (Content-Length check, then a streamed cutoff)
                // rather than measured after the fact — a 100MB attachment
                // must not be fully buffered before this limit has a chance
                // to reject it.
                let file;
                try {
                    file = await c.getBinary(`/attachments/${p.attachmentId}/download`, {}, 0, MAX_INLINE_DOWNLOAD_BYTES);
                } catch (err) {
                    if (err instanceof BinaryTooLargeError) {
                        throw new Error(
                            `Attachment is over the ${MAX_INLINE_DOWNLOAD_BYTES}-byte inline limit. ` +
                            `Use mode: 'url' to get a short-lived download link instead.`
                        );
                    }
                    throw err;
                }
                return {
                    attachmentId: p.attachmentId,
                    contentType: file.contentType,
                    ...(file.filename ? { filename: file.filename } : {}),
                    size: file.data.byteLength,
                    encoding: 'base64',
                    content: file.data.toString('base64'),
                    note:
                        "This is base64 file content for a program to consume, not for you to retype. " +
                        "Do not reproduce it verbatim in a chat reply — that is unreliable at this length " +
                        "and a corrupted copy is a silent failure. To hand this file to a person, call " +
                        "get_attachment again with mode: 'url'.",
                };
            }
        ),
        def('delete_attachment', 'Delete an attachment.', S.DeleteAttachmentSchema, (c, p) =>
            c.delete(`/attachments/${p.attachmentId}`)
        ),
    ];
}