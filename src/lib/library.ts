export type BookLocation = '成都' | '重庆';

export interface BookDraft {
  title: string;
  author: string;
  publisher: string;
  year: string;
  isbn: string;
  location: BookLocation;
  coverUrl: string;
  coverObjectKey: string;
}

export interface Book extends BookDraft {
  id: string;
  ownerEmail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  authenticated: boolean;
  email: string | null;
  authMode: 'local-dev' | 'cloudflare-access' | 'unknown';
  runtime: 'local-storage' | 'cloudflare-api';
  message?: string;
}

const LOCAL_STORAGE_KEY = 'home-library.books.v1';
const DEFAULT_LOCAL_EMAIL = 'local@home-library.dev';

function resolveDataMode() {
  const configuredMode = import.meta.env.VITE_DATA_MODE?.trim().toLowerCase();

  if (configuredMode === 'api') {
    return 'api' as const;
  }

  if (configuredMode === 'local') {
    return 'local' as const;
  }

  return import.meta.env.DEV ? ('local' as const) : ('api' as const);
}

function normalizeDraft(input: BookDraft): BookDraft {
  return {
    title: input.title.trim(),
    author: input.author.trim(),
    publisher: input.publisher.trim(),
    year: input.year.trim(),
    isbn: input.isbn.trim(),
    location: input.location,
    coverUrl: input.coverUrl.trim(),
    coverObjectKey: input.coverObjectKey.trim(),
  };
}

function normalizeStoredBook(input: Partial<Book>): Book {
  const now = new Date().toISOString();

  return {
    id: typeof input.id === 'string' ? input.id : crypto.randomUUID(),
    title: typeof input.title === 'string' ? input.title : '',
    author: typeof input.author === 'string' ? input.author : '',
    publisher: typeof input.publisher === 'string' ? input.publisher : '',
    year: typeof input.year === 'string' ? input.year : '',
    isbn: typeof input.isbn === 'string' ? input.isbn : '',
    location: input.location === '重庆' ? '重庆' : '成都',
    coverUrl: typeof input.coverUrl === 'string' ? input.coverUrl : '',
    coverObjectKey: typeof input.coverObjectKey === 'string' ? input.coverObjectKey : '',
    ownerEmail: typeof input.ownerEmail === 'string' ? input.ownerEmail : undefined,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
  };
}

function sortBooks(books: Book[]) {
  return [...books].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function getLocalEmail() {
  return import.meta.env.VITE_DEV_ACCESS_EMAIL?.trim() || DEFAULT_LOCAL_EMAIL;
}

function readLocalBooks() {
  if (typeof window === 'undefined') {
    return [] as Book[];
  }

  const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);

  if (!raw) {
    return [] as Book[];
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Book>[];
    return sortBooks(parsed.map((book) => normalizeStoredBook(book)));
  } catch {
    return [] as Book[];
  }
}

function writeLocalBooks(books: Book[]) {
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sortBooks(books)));
}

async function parseError(response: Response) {
  try {
    const data = (await response.json()) as {error?: string; message?: string};
    return data.error || data.message || `请求失败: ${response.status}`;
  } catch {
    return `请求失败: ${response.status}`;
  }
}

async function requestJson<T>(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);

  if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return (await response.json()) as T;
}

export function getRuntimeLabel(session: SessionInfo | null) {
  if (!session) {
    return '初始化中';
  }

  if (session.runtime === 'local-storage') {
    return '本地测试';
  }

  if (session.authMode === 'cloudflare-access') {
    return 'Cloudflare Access';
  }

  return 'Cloudflare API';
}

export async function getSession(): Promise<SessionInfo> {
  if (resolveDataMode() === 'local') {
    return {
      authenticated: true,
      email: getLocalEmail(),
      authMode: 'local-dev',
      runtime: 'local-storage',
      message: '当前为本地测试模式，书籍数据保存在浏览器 localStorage。',
    };
  }

  const response = await fetch('/api/session', {
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.status === 401) {
    return (await response.json()) as SessionInfo;
  }

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return (await response.json()) as SessionInfo;
}

export async function listBooks() {
  if (resolveDataMode() === 'local') {
    return readLocalBooks();
  }

  const data = await requestJson<{books: Book[]}>('/api/books', {
    headers: {
      Accept: 'application/json',
    },
  });

  return sortBooks(data.books);
}

export function getCoverImageUrl(coverObjectKey: string, coverUrl = '') {
  if (coverObjectKey) {
    return `/api/covers/${encodeURIComponent(coverObjectKey)}`;
  }

  return coverUrl;
}

export async function uploadCover(file: File) {
  if (resolveDataMode() === 'local') {
    throw new Error('本地 localStorage 模式不支持上传封面，请切换到 API 模式并启动 Worker。');
  }

  const formData = new FormData();
  formData.append('file', file);

  const data = await requestJson<{coverObjectKey: string}>('/api/covers', {
    method: 'POST',
    body: formData,
  });

  return data;
}

export async function deleteUploadedCover(coverObjectKey: string) {
  if (!coverObjectKey || resolveDataMode() === 'local') {
    return;
  }

  await requestJson<{success: true}>(`/api/covers/${encodeURIComponent(coverObjectKey)}`, {
    method: 'DELETE',
  });
}

export async function createBook(input: BookDraft) {
  const book = normalizeDraft(input);

  if (resolveDataMode() === 'local') {
    const now = new Date().toISOString();
    const created: Book = {
      id: crypto.randomUUID(),
      ownerEmail: getLocalEmail(),
      createdAt: now,
      updatedAt: now,
      ...book,
    };

    const books = readLocalBooks();
    writeLocalBooks([created, ...books]);
    return created;
  }

  const data = await requestJson<{book: Book}>('/api/books', {
    method: 'POST',
    body: JSON.stringify(book),
  });

  return data.book;
}

export async function updateBook(id: string, input: BookDraft) {
  const book = normalizeDraft(input);

  if (resolveDataMode() === 'local') {
    const books = readLocalBooks();
    const current = books.find((candidate) => candidate.id === id);

    if (!current) {
      throw new Error('未找到要更新的书籍。');
    }

    const updated: Book = {
      ...current,
      ...book,
      updatedAt: new Date().toISOString(),
    };

    writeLocalBooks(books.map((candidate) => (candidate.id === id ? updated : candidate)));
    return updated;
  }

  const data = await requestJson<{book: Book}>(`/api/books/${id}`, {
    method: 'PUT',
    body: JSON.stringify(book),
  });

  return data.book;
}

export async function removeBook(id: string) {
  if (resolveDataMode() === 'local') {
    const books = readLocalBooks();
    writeLocalBooks(books.filter((candidate) => candidate.id !== id));
    return;
  }

  await requestJson<{success: true}>(`/api/books/${id}`, {
    method: 'DELETE',
  });
}

export function logout(session: SessionInfo | null) {
  if (!session || session.runtime === 'local-storage') {
    return false;
  }

  window.location.assign('/cdn-cgi/access/logout');
  return true;
}