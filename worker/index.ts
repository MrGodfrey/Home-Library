import {createRemoteJWKSet, jwtVerify} from 'jose';

interface BookPayload {
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
  year?: unknown;
  isbn?: unknown;
  location?: unknown;
  coverUrl?: unknown;
  coverObjectKey?: unknown;
}

interface AuthResult {
  authenticated: boolean;
  email: string | null;
  authMode: 'local-dev' | 'cloudflare-access' | 'unknown';
  message?: string;
}

interface DbStatement {
  bind: (...values: unknown[]) => {
    first: <T = unknown>() => Promise<T | null>;
    all: <T = unknown>() => Promise<{results: T[]}>;
    run: () => Promise<unknown>;
  };
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{results: T[]}>;
  run: () => Promise<unknown>;
}

interface DatabaseBinding {
  prepare: (sql: string) => DbStatement;
}

interface R2HttpMetadata {
  contentType?: string;
}

interface R2ObjectBody {
  body: ReadableStream | null;
  httpEtag?: string;
  httpMetadata?: R2HttpMetadata;
  writeHttpMetadata?: (headers: Headers) => void;
}

interface R2BucketBinding {
  get: (key: string) => Promise<R2ObjectBody | null>;
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: {
      httpMetadata?: R2HttpMetadata;
      customMetadata?: Record<string, string>;
    },
  ) => Promise<unknown>;
  delete: (key: string) => Promise<void>;
}

interface WorkerEnv {
  DB?: DatabaseBinding;
  BOOK_COVERS?: R2BucketBinding;
  ALLOW_DEV_AUTH?: string;
  DEV_ACCESS_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

const MAX_COVER_SIZE_BYTES = 10 * 1024 * 1024;
const COVER_EXTENSION_BY_TYPE: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeTeamDomain(value: string) {
  const trimmed = value.trim().replace(/^['\"]|['\"]$/g, '').replace(/\/+$/, '');

  if (!trimmed) {
    return '';
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    return new URL(candidate).origin;
  } catch {
    throw new Error(
      'TEAM_DOMAIN 配置无效，请填写 Zero Trust team 域名，例如 https://your-team.cloudflareaccess.com',
    );
  }
}

function normalizePayload(payload: BookPayload) {
  if (!isNonEmptyString(payload.title)) {
    throw new Error('书名不能为空。');
  }

  if (payload.location !== '成都' && payload.location !== '重庆') {
    throw new Error('所在地必须是成都或重庆。');
  }

  return {
    title: payload.title.trim(),
    author: typeof payload.author === 'string' ? payload.author.trim() : '',
    publisher: typeof payload.publisher === 'string' ? payload.publisher.trim() : '',
    year: typeof payload.year === 'string' ? payload.year.trim() : '',
    isbn: typeof payload.isbn === 'string' ? payload.isbn.trim() : '',
    location: payload.location,
    coverUrl: typeof payload.coverUrl === 'string' ? payload.coverUrl.trim() : '',
    coverObjectKey: typeof payload.coverObjectKey === 'string' ? payload.coverObjectKey.trim() : '',
  };
}

function decodeCoverObjectKey(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('封面对象键无效。');
  }
}

function getCoverExtension(file: File) {
  const byType = COVER_EXTENSION_BY_TYPE[file.type];

  if (byType) {
    return byType;
  }

  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const fromName = match?.[1];

  if (fromName && Object.values(COVER_EXTENSION_BY_TYPE).includes(fromName)) {
    return fromName;
  }

  throw new Error('仅支持 JPG、PNG、WEBP、GIF 或 AVIF 格式的封面图片。');
}

function buildCoverObjectKey(file: File) {
  const day = new Date().toISOString().slice(0, 10);
  const extension = getCoverExtension(file);
  return `covers/${day}/${crypto.randomUUID()}.${extension}`;
}

async function requireCoverBucket(env: WorkerEnv) {
  if (!env.BOOK_COVERS) {
    throw new Error('未找到 R2 绑定，请在 Cloudflare Worker 中绑定名为 BOOK_COVERS 的 R2 存储桶。');
  }

  return env.BOOK_COVERS;
}

async function deleteCoverObject(env: WorkerEnv, coverObjectKey: string) {
  if (!coverObjectKey || !env.BOOK_COVERS) {
    return;
  }

  await env.BOOK_COVERS.delete(coverObjectKey);
}

async function getIdentity(request: Request, env: WorkerEnv): Promise<AuthResult> {
  const allowDevAuth = env.ALLOW_DEV_AUTH === 'true';
  const devEmail = request.headers.get('x-dev-access-email') || String(env.DEV_ACCESS_EMAIL || '');

  if (allowDevAuth && devEmail.trim()) {
    return {
      authenticated: true,
      email: devEmail.trim(),
      authMode: 'local-dev',
      message: '当前通过开发态身份访问 API。',
    };
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  const teamDomain = normalizeTeamDomain(typeof env.TEAM_DOMAIN === 'string' ? env.TEAM_DOMAIN : '');
  const policyAud = typeof env.POLICY_AUD === 'string' ? env.POLICY_AUD : '';

  if (!token) {
    return {
      authenticated: false,
      email: null,
      authMode: 'unknown',
      message: '请先通过 Cloudflare Access 登录。',
    };
  }

  if (!teamDomain || !policyAud) {
    throw new Error('缺少 TEAM_DOMAIN 或 POLICY_AUD 配置，无法校验 Cloudflare Access JWT。');
  }

  const jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', `${teamDomain}/`));
  const {payload} = await jwtVerify(token, jwks, {
    issuer: teamDomain,
    audience: policyAud,
  });

  const email = typeof payload.email === 'string' ? payload.email : typeof payload.sub === 'string' ? payload.sub : null;

  return {
    authenticated: true,
    email,
    authMode: 'cloudflare-access',
  };
}

async function requireDb(env: WorkerEnv) {
  if (!env.DB) {
    throw new Error('未找到 D1 绑定，请在 Cloudflare Worker 中绑定名为 DB 的 D1 数据库。');
  }

  return env.DB;
}

async function handleSession(request: Request, env: WorkerEnv) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated) {
    return json(
      {
        authenticated: false,
        email: null,
        authMode: 'unknown',
        runtime: 'cloudflare-api',
        message: auth.message,
      },
      401,
    );
  }

  return json({
    authenticated: true,
    email: auth.email,
    authMode: auth.authMode,
    runtime: 'cloudflare-api',
    message: auth.message,
  });
}

async function handleListBooks(request: Request, env: WorkerEnv) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated) {
    return json({error: auth.message || '未认证。'}, 401);
  }

  const db = await requireDb(env);
  const result = await db
    .prepare(
      `
      SELECT
        id,
        title,
        author,
        publisher,
        year,
        isbn,
        location,
        cover_url AS coverUrl,
        cover_object_key AS coverObjectKey,
        owner_email AS ownerEmail,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM books
      ORDER BY datetime(created_at) DESC
      `,
    )
    .all();

  return json({books: result.results});
}

async function handleCreateBook(request: Request, env: WorkerEnv) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated || !auth.email) {
    return json({error: auth.message || '未认证。'}, 401);
  }

  const db = await requireDb(env);
  const payload = normalizePayload((await request.json()) as BookPayload);
  const id = crypto.randomUUID();

  await db
    .prepare(
      `
      INSERT INTO books (
        id,
        title,
        author,
        publisher,
        year,
        isbn,
        location,
        status,
        cover_url,
        cover_object_key,
        owner_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '在家', ?, ?, ?)
      `,
    )
    .bind(
      id,
      payload.title,
      payload.author,
      payload.publisher,
      payload.year,
      payload.isbn,
      payload.location,
      payload.coverUrl,
      payload.coverObjectKey,
      auth.email,
    )
    .run();

  const book = await db
    .prepare(
      `
      SELECT
        id,
        title,
        author,
        publisher,
        year,
        isbn,
        location,
        cover_url AS coverUrl,
        cover_object_key AS coverObjectKey,
        owner_email AS ownerEmail,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM books
      WHERE id = ?
      `,
    )
    .bind(id)
    .first();

  return json({book}, 201);
}

async function handleUpdateBook(request: Request, env: WorkerEnv, id: string) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated) {
    return json({error: auth.message || '未认证。'}, 401);
  }

  const db = await requireDb(env);
  const payload = normalizePayload((await request.json()) as BookPayload);

  await db
    .prepare(
      `
      UPDATE books
      SET
        title = ?,
        author = ?,
        publisher = ?,
        year = ?,
        isbn = ?,
        location = ?,
        status = '在家',
        cover_url = ?,
        cover_object_key = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
    )
    .bind(
      payload.title,
      payload.author,
      payload.publisher,
      payload.year,
      payload.isbn,
      payload.location,
      payload.coverUrl,
      payload.coverObjectKey,
      id,
    )
    .run();

  const book = await db
    .prepare(
      `
      SELECT
        id,
        title,
        author,
        publisher,
        year,
        isbn,
        location,
        cover_url AS coverUrl,
        cover_object_key AS coverObjectKey,
        owner_email AS ownerEmail,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM books
      WHERE id = ?
      `,
    )
    .bind(id)
    .first();

  if (!book) {
    return json({error: '未找到要更新的书籍。'}, 404);
  }

  return json({book});
}

async function handleUploadCover(request: Request, env: WorkerEnv) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated) {
    return json({error: auth.message || '未认证。'}, 401);
  }

  const bucket = await requireCoverBucket(env);
  const formData = await request.formData();
  const entry = formData.get('file');

  if (!(entry instanceof File)) {
    throw new Error('请先选择一张封面图片。');
  }

  if (entry.size === 0) {
    throw new Error('封面图片不能为空。');
  }

  if (entry.size > MAX_COVER_SIZE_BYTES) {
    throw new Error('封面图片不能超过 10MB。');
  }

  const coverObjectKey = buildCoverObjectKey(entry);
  const customMetadata: Record<string, string> = {};

  if (auth.email) {
    customMetadata.uploadedBy = auth.email;
  }

  if (entry.name) {
    customMetadata.originalFilename = entry.name.slice(0, 200);
  }

  await bucket.put(coverObjectKey, await entry.arrayBuffer(), {
    httpMetadata: {
      contentType: entry.type || undefined,
    },
    customMetadata,
  });

  return json({coverObjectKey}, 201);
}

async function handleGetCover(env: WorkerEnv, coverObjectKey: string) {
  const bucket = await requireCoverBucket(env);
  const object = await bucket.get(coverObjectKey);

  if (!object) {
    return new Response('Not Found', {status: 404});
  }

  const headers = new Headers({
    'Cache-Control': 'public, max-age=31536000, immutable',
  });

  object.writeHttpMetadata?.(headers);

  if (!headers.has('Content-Type') && object.httpMetadata?.contentType) {
    headers.set('Content-Type', object.httpMetadata.contentType);
  }

  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag);
  }

  return new Response(object.body, {headers});
}

async function handleDeleteCover(request: Request, env: WorkerEnv, coverObjectKey: string) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated) {
    return json({error: auth.message || '未认证。'}, 401);
  }

  await deleteCoverObject(env, coverObjectKey);
  return json({success: true});
}

async function handleDeleteBook(request: Request, env: WorkerEnv, id: string) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated) {
    return json({error: auth.message || '未认证。'}, 401);
  }

  const db = await requireDb(env);
  const existingBook = await db
    .prepare(
      `
      SELECT cover_object_key AS coverObjectKey
      FROM books
      WHERE id = ?
      `,
    )
    .bind(id)
    .first<{coverObjectKey?: string}>();

  await db
    .prepare(
      `
      DELETE FROM books
      WHERE id = ?
      `,
    )
    .bind(id)
    .run();

  await deleteCoverObject(env, existingBook?.coverObjectKey || '');

  return json({success: true});
}

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, '');
    const segments = path.split('/').filter(Boolean);

    try {
      if (segments.length === 1 && segments[0] === 'session' && request.method === 'GET') {
        return await handleSession(request, env);
      }

      if (segments.length === 1 && segments[0] === 'books' && request.method === 'GET') {
        return await handleListBooks(request, env);
      }

      if (segments.length === 1 && segments[0] === 'books' && request.method === 'POST') {
        return await handleCreateBook(request, env);
      }

      if (segments.length === 1 && segments[0] === 'covers' && request.method === 'POST') {
        return await handleUploadCover(request, env);
      }

      if (segments.length >= 2 && segments[0] === 'covers' && request.method === 'GET') {
        return await handleGetCover(env, decodeCoverObjectKey(segments.slice(1).join('/')));
      }

      if (segments.length >= 2 && segments[0] === 'covers' && request.method === 'DELETE') {
        return await handleDeleteCover(request, env, decodeCoverObjectKey(segments.slice(1).join('/')));
      }

      if (segments.length === 2 && segments[0] === 'books' && request.method === 'PUT') {
        return await handleUpdateBook(request, env, segments[1]);
      }

      if (segments.length === 2 && segments[0] === 'books' && request.method === 'DELETE') {
        return await handleDeleteBook(request, env, segments[1]);
      }

      return json({error: '未找到接口。'}, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      return json({error: message}, 500);
    }
  },
};