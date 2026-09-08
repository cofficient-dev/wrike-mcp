import type { WrikeClient } from '../wrikeClient.js';
import * as S from './schemas.js';
import { z } from 'zod';

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
        def('get_folder_tree', 'Get the folder/project tree below a folder (use Root API ID for account tree).', S.GetFolderTreeSchema, (c, p) =>
            c.get(`/folders/${p.folderId}`, { descendants: 'true' })
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
        def('search', 'Search tasks, folders, and contacts by title query.', S.SearchSchema, (c, p) =>
            c.get('/search', { query: p.query, limit: p.limit })
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
        def('list_timelogs', 'List timelogs with filters (folder, contacts, categories, date range, pagination).', S.ListTimelogsSchema, (c, p) => {
            const { folderId, ...rest } = p;
            return folderId
                ? c.get(`/folders/${folderId}/timelogs`, query(rest))
                : c.get('/timelogs', query(rest));
        }),
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
        def('list_attachments', 'List attachments on a task or folder.', S.ListAttachmentsSchema, (c, p) =>
            c.get(`/${p.targetType}/${p.targetId}/attachments`, query({ withUrl: p.withUrl, fields: p.fields }))
        ),
        def('get_attachment', 'Get an attachment by ID (metadata; optionally a short-lived download URL).', S.GetAttachmentSchema, (c, p) =>
            c.get(`/attachments/${p.attachmentId}`, query({ withUrl: p.withUrl }))
        ),
        def('delete_attachment', 'Delete an attachment.', S.DeleteAttachmentSchema, (c, p) =>
            c.delete(`/attachments/${p.attachmentId}`)
        ),
    ];
}