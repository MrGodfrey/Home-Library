import {createRemoteJWKSet, jwtVerify} from 'jose';

interface BookPayload {
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
  year?: unknown;
  isbn?: unknown;
  location?: unknown;
  status?: unknown;
  coverUrl?: unknown;
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

interface WorkerEnv {
  DB?: DatabaseBinding;
  ALLOW_DEV_AUTH?: string;
  DEV_ACCESS_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

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

function normalizePayload(payload: BookPayload) {
  if (!isNonEmptyString(payload.title)) {
    throw new Error('书名不能为空。');
  }

  if (payload.location !== '成都' && payload.location !== '重庆') {
    throw new Error('所在地必须是成都或重庆。');
  }

  if (payload.status !== '在家' && payload.status !== '不在家') {
    throw new Error('状态必须是“在家”或“不在家”。');
  }

  return {
    title: payload.title.trim(),
    author: typeof payload.author === 'string' ? payload.author.trim() : '',
    publisher: typeof payload.publisher === 'string' ? payload.publisher.trim() : '',
    year: typeof payload.year === 'string' ? payload.year.trim() : '',
    isbn: typeof payload.isbn === 'string' ? payload.isbn.trim() : '',
    location: payload.location,
    status: payload.status,
    coverUrl: typeof payload.coverUrl === 'string' ? payload.coverUrl.trim() : '',
  };
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
  const teamDomain = typeof env.TEAM_DOMAIN === 'string' ? env.TEAM_DOMAIN : '';
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

  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
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
        status,
        cover_url AS coverUrl,
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
        owner_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      payload.status,
      payload.coverUrl,
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
        status,
        cover_url AS coverUrl,
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
        status = ?,
        cover_url = ?,
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
      payload.status,
      payload.coverUrl,
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
        status,
        cover_url AS coverUrl,
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

async function handleDeleteBook(request: Request, env: WorkerEnv, id: string) {
  const auth = await getIdentity(request, env);

  if (!auth.authenticated) {
    return json({error: auth.message || '未认证。'}, 401);
  }

  const db = await requireDb(env);

  await db
    .prepare(
      `
      DELETE FROM books
      WHERE id = ?
      `,
    )
    .bind(id)
    .run();

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