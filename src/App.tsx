import {useEffect, useRef, useState, type ChangeEvent, type FormEvent} from 'react';
import {
  AlertCircle,
  BookOpen,
  Image,
  Loader2,
  LogOut,
  Plus,
  RefreshCcw,
  ScanLine,
  Search,
  ShieldCheck,
  Trash2,
  Edit2,
  Upload,
  X,
} from 'lucide-react';
import {AnimatePresence, motion} from 'motion/react';
import {Toaster, toast} from 'sonner';
import {
  createBook,
  deleteUploadedCover,
  getRuntimeLabel,
  getCoverImageUrl,
  getSession,
  listBooks,
  logout,
  removeBook,
  uploadCover,
  updateBook,
  type Book,
  type BookDraft,
  type SessionInfo,
} from './lib/library';

type ScannerInstance = {
  clear: () => void;
  stop: () => Promise<void>;
};

type CameraOption = {
  id: string;
  label: string;
};

const emptyForm: BookDraft = {
  title: '',
  author: '',
  publisher: '',
  year: '',
  isbn: '',
  location: '成都',
  coverUrl: '',
  coverObjectKey: '',
};

function BootScreen({label}: {label: string}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6f6f1] p-6">
      <div className="bg-white rounded-3xl border border-gray-100 shadow-xl px-10 py-12 text-center max-w-sm w-full">
        <Loader2 className="animate-spin text-green-700 mx-auto mb-4" size={40} />
        <p className="text-sm uppercase tracking-[0.3em] text-gray-400 mb-2">家藏万卷</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">正在初始化书库</h1>
        <p className="text-gray-500">{label}</p>
      </div>
    </div>
  );
}

function ProtectedNotice({message, onRetry}: {message: string; onRetry: () => void}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6f6f1] p-6">
      <div className="max-w-md w-full rounded-3xl bg-white border border-gray-100 shadow-xl p-8 text-center">
        <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-6">
          <ShieldCheck size={40} className="text-emerald-700" />
        </div>
        <h1 className="text-3xl font-bold text-gray-900 mb-3">此站点受 Access 保护</h1>
        <p className="text-gray-500 leading-7 mb-8">{message}</p>
        <button
          onClick={onRetry}
          className="w-full py-3 rounded-2xl bg-emerald-700 text-white font-bold hover:bg-emerald-800 transition-colors"
        >
          重新检测会话
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [isBooksLoading, setIsBooksLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'全部' | '成都' | '重庆'>('全部');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [cameraOptions, setCameraOptions] = useState<CameraOption[]>([]);
  const [activeCameraId, setActiveCameraId] = useState<string>('');
  const [isScannerStarting, setIsScannerStarting] = useState(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [formData, setFormData] = useState<BookDraft>(emptyForm);
  const scannerRef = useRef<ScannerInstance | null>(null);
  const scannerStartTokenRef = useRef(0);
  const initialCoverRef = useRef({coverObjectKey: '', coverUrl: ''});

  const canUploadCover = session?.runtime === 'cloudflare-api';
  const formCoverUrl = getCoverImageUrl(formData.coverObjectKey, formData.coverUrl);
  const hasLegacyCover = !formData.coverObjectKey && Boolean(formData.coverUrl);

  async function loadBooks() {
    setIsBooksLoading(true);

    try {
      const nextBooks = await listBooks();
      setBooks(nextBooks);
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载藏书失败。';
      toast.error(message);
    } finally {
      setIsBooksLoading(false);
    }
  }

  async function bootstrap() {
    setIsBooting(true);
    setBootstrapError(null);

    try {
      const nextSession = await getSession();
      setSession(nextSession);

      if (nextSession.authenticated) {
        await loadBooks();
      } else {
        setBooks([]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '初始化失败。';
      setBootstrapError(message);
    } finally {
      setIsBooting(false);
    }
  }

  async function stopScanner() {
    const scanner = scannerRef.current;

    if (scanner) {
      try {
        await scanner.stop();
      } catch {
        // Ignore scanner cleanup errors.
      }

      try {
        scanner.clear();
      } catch {
        // Ignore scanner cleanup errors.
      }
    }

    scannerStartTokenRef.current += 1;
    scannerRef.current = null;
    setIsScannerStarting(false);
    setIsScanning(false);
  }

  useEffect(() => {
    void bootstrap();

    return () => {
      void stopScanner();
    };
  }, []);

  async function fetchBookInfo(isbn: string) {
    const cleanIsbn = isbn.replace(/[-\s]/g, '');

    if (!cleanIsbn) {
      toast.error('请先输入或扫描 ISBN。');
      return;
    }

    toast.loading('正在获取书籍信息...', {id: 'isbn-fetch'});

    try {
      const googleResponse = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`);
      const googleData = (await googleResponse.json()) as {
        items?: Array<{
          volumeInfo?: {
            title?: string;
            authors?: string[];
            publisher?: string;
            publishedDate?: string;
            imageLinks?: {thumbnail?: string};
          };
        }>;
      };

      if (googleData.items?.length) {
        const info = googleData.items[0].volumeInfo;

        setFormData((current) => ({
          ...current,
          title: info?.title || '',
          author: info?.authors?.join(', ') || '',
          publisher: info?.publisher || '',
          year: info?.publishedDate || '',
          isbn: cleanIsbn,
        }));

        toast.success('已从 Google Books 自动补全。', {id: 'isbn-fetch'});
        return;
      }

      const openLibraryResponse = await fetch(
        `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`,
      );
      const openLibraryData = (await openLibraryResponse.json()) as Record<
        string,
        {
          title?: string;
          publish_date?: string;
          cover?: {large?: string; medium?: string};
          authors?: Array<{name?: string}>;
          publishers?: Array<{name?: string}>;
        }
      >;
      const bookData = openLibraryData[`ISBN:${cleanIsbn}`];

      if (bookData) {
        setFormData((current) => ({
          ...current,
          title: bookData.title || '',
          author: bookData.authors?.map((item) => item.name).filter(Boolean).join(', ') || '',
          publisher: bookData.publishers?.map((item) => item.name).filter(Boolean).join(', ') || '',
          year: bookData.publish_date || '',
          isbn: cleanIsbn,
        }));

        toast.success('已从 Open Library 自动补全。', {id: 'isbn-fetch'});
        return;
      }

      toast.error('没有查到这本书，请手动补录。', {id: 'isbn-fetch'});
    } catch {
      toast.error('外部书籍接口不可用，请手动录入。', {id: 'isbn-fetch'});
    }
  }

  function normalizeIsbn(candidate: string) {
    return candidate.replace(/[^0-9Xx]/g, '').toUpperCase();
  }

  function extractIsbnFromScan(decodedText: string) {
    const directMatch = normalizeIsbn(decodedText);

    if (directMatch.length === 10 || directMatch.length === 13) {
      return directMatch;
    }

    const embeddedMatch = decodedText.match(/(?:97[89][0-9]{10}|[0-9]{9}[0-9Xx])/);

    if (!embeddedMatch) {
      return '';
    }

    return normalizeIsbn(embeddedMatch[0]);
  }

  function getPreferredCamera(cameras: CameraOption[]) {
    if (activeCameraId && cameras.some((camera) => camera.id === activeCameraId)) {
      return activeCameraId;
    }

    const rearCamera = cameras.find((camera) => /back|rear|environment|wide/i.test(camera.label));

    return rearCamera?.id || cameras[0]?.id || '';
  }

  async function runScannerWithCamera(cameraId?: string) {
    const targetToken = ++scannerStartTokenRef.current;
    setIsScannerStarting(true);

    try {
      const {Html5Qrcode, Html5QrcodeSupportedFormats} = await import('html5-qrcode');
      const nextScanner = new Html5Qrcode('reader', {
        verbose: false,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.UPC_EAN_EXTENSION,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
        ],
        useBarCodeDetectorIfSupported: true,
      });

      const cameras = (await Html5Qrcode.getCameras()).map((camera) => ({
        id: camera.id,
        label: camera.label || '未命名摄像头',
      }));

      if (targetToken !== scannerStartTokenRef.current) {
        return;
      }

      if (cameras.length > 0) {
        setCameraOptions(cameras);
      }

      const preferredCameraId = cameraId || getPreferredCamera(cameras);

      await nextScanner.start(
        preferredCameraId
          ? preferredCameraId
          : {
              facingMode: {exact: 'environment'},
            },
        {
          fps: 12,
          qrbox: {width: 260, height: 160},
          aspectRatio: 1.777778,
          disableFlip: false,
        },
        (decodedText) => {
          const isbn = extractIsbnFromScan(decodedText);

          if (!isbn) {
            return;
          }

          setFormData((current) => ({
            ...current,
            isbn,
          }));

          void stopScanner();
          void fetchBookInfo(isbn);
        },
        () => undefined,
      );

      if (targetToken !== scannerStartTokenRef.current) {
        try {
          await nextScanner.stop();
        } catch {
          // Ignore scanner cleanup errors.
        }
        nextScanner.clear();
        return;
      }

      scannerRef.current = nextScanner;
      setActiveCameraId(preferredCameraId);
      setIsScannerStarting(false);
    } catch (error) {
      if (targetToken !== scannerStartTokenRef.current) {
        return;
      }

      setIsScannerStarting(false);
      const message = error instanceof Error ? error.message : String(error);

      if (!cameraId && /environment|facingmode/i.test(message)) {
        try {
          const {Html5Qrcode} = await import('html5-qrcode');
          const cameras = (await Html5Qrcode.getCameras()).map((camera) => ({
            id: camera.id,
            label: camera.label || '未命名摄像头',
          }));

          if (targetToken !== scannerStartTokenRef.current) {
            return;
          }

          setCameraOptions(cameras);
          const fallbackCameraId = getPreferredCamera(cameras);

          if (fallbackCameraId) {
            await runScannerWithCamera(fallbackCameraId);
            return;
          }
        } catch {
          // Fall through to generic error handling.
        }
      }

      await stopScanner();
      toast.error('无法启动扫码，请检查相机权限或改用其他摄像头。');
    }
  }

  function openModal(book?: Book) {
    if (book) {
      setEditingBook(book);
      initialCoverRef.current = {
        coverObjectKey: book.coverObjectKey,
        coverUrl: book.coverUrl,
      };
      setFormData({
        title: book.title,
        author: book.author,
        publisher: book.publisher,
        year: book.year,
        isbn: book.isbn,
        location: book.location,
        coverUrl: book.coverUrl,
        coverObjectKey: book.coverObjectKey,
      });
    } else {
      setEditingBook(null);
      initialCoverRef.current = {
        coverObjectKey: '',
        coverUrl: '',
      };
      setFormData({
        ...emptyForm,
        location: activeTab === '全部' ? '成都' : activeTab,
      });
    }

    setIsModalOpen(true);
  }

  async function cleanupUnsavedCoverUpload() {
    const initialCoverObjectKey = initialCoverRef.current.coverObjectKey;

    if (!formData.coverObjectKey || formData.coverObjectKey === initialCoverObjectKey) {
      return;
    }

    try {
      await deleteUploadedCover(formData.coverObjectKey);
    } catch {
      // Ignore temporary cover cleanup failures.
    }
  }

  async function closeModal(options?: {preserveUploadedCover?: boolean}) {
    if (!options?.preserveUploadedCover) {
      await cleanupUnsavedCoverUpload();
    }

    await stopScanner();
    setCameraOptions([]);
    setActiveCameraId('');
    setEditingBook(null);
    setFormData(emptyForm);
    setIsModalOpen(false);
    setIsUploadingCover(false);
    initialCoverRef.current = {
      coverObjectKey: '',
      coverUrl: '',
    };
  }

  function startScanner() {
    if (isScanning || isScannerStarting) {
      return;
    }

    setIsScanning(true);
    setCameraOptions([]);

    window.setTimeout(async () => {
      await runScannerWithCamera();
    }, 120);
  }

  async function handleCameraChange(cameraId: string) {
    if (!cameraId || cameraId === activeCameraId) {
      return;
    }

    const currentScanner = scannerRef.current;
    setActiveCameraId(cameraId);

    if (currentScanner) {
      try {
        await currentScanner.stop();
      } catch {
        // Ignore scanner cleanup errors.
      }

      try {
        currentScanner.clear();
      } catch {
        // Ignore scanner cleanup errors.
      }

      scannerRef.current = null;
    }

    await runScannerWithCamera(cameraId);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session?.authenticated) {
      toast.error('当前会话未通过认证。');
      return;
    }

    setIsSaving(true);

    try {
      const previousCoverObjectKey = initialCoverRef.current.coverObjectKey;
      const nextCoverObjectKey = formData.coverObjectKey;

      if (editingBook) {
        await updateBook(editingBook.id, formData);
        toast.success('书籍信息已更新。');
      } else {
        await createBook(formData);
        toast.success('新书已加入书库。');
      }

      if (previousCoverObjectKey && previousCoverObjectKey !== nextCoverObjectKey) {
        void deleteUploadedCover(previousCoverObjectKey).catch(() => undefined);
      }

      await closeModal({preserveUploadedCover: true});
      await loadBooks();
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败。';
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setIsDeleting(true);

    try {
      await removeBook(id);
      setDeleteConfirmId(null);
      toast.success('书籍已从书库移除。');
      await loadBooks();
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败。';
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleCoverFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件。');
      return;
    }

    setIsUploadingCover(true);

    try {
      const currentCoverObjectKey = formData.coverObjectKey;
      const initialCoverObjectKey = initialCoverRef.current.coverObjectKey;
      const uploaded = await uploadCover(file);

      if (currentCoverObjectKey && currentCoverObjectKey !== initialCoverObjectKey) {
        void deleteUploadedCover(currentCoverObjectKey).catch(() => undefined);
      }

      setFormData((current) => ({
        ...current,
        coverObjectKey: uploaded.coverObjectKey,
      }));
      toast.success('封面已上传到 R2。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传封面失败。';
      toast.error(message);
    } finally {
      setIsUploadingCover(false);
    }
  }

  async function handleRemoveCover() {
    const initialCoverObjectKey = initialCoverRef.current.coverObjectKey;

    if (formData.coverObjectKey && formData.coverObjectKey !== initialCoverObjectKey) {
      try {
        await deleteUploadedCover(formData.coverObjectKey);
      } catch {
        // Ignore temporary cover cleanup failures.
      }
    }

    setFormData((current) => ({
      ...current,
      coverUrl: '',
      coverObjectKey: '',
    }));
  }

  function handleLogout() {
    const redirected = logout(session);

    if (!redirected) {
      toast.message('当前为本地测试模式，无需退出登录。');
    }
  }

  const filteredBooks = books.filter((book) => {
    const keyword = searchQuery.trim().toLowerCase();
    const matchesSearch =
      keyword.length === 0 ||
      book.title.toLowerCase().includes(keyword) ||
      book.author.toLowerCase().includes(keyword) ||
      book.isbn.includes(searchQuery.trim());
    const matchesTab = activeTab === '全部' || book.location === activeTab;

    return matchesSearch && matchesTab;
  });

  if (isBooting) {
    return <BootScreen label="正在确认运行模式与藏书数据源。" />;
  }

  if (bootstrapError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f6f6f1] p-6">
        <div className="max-w-md w-full bg-white border border-red-100 rounded-3xl shadow-xl p-8">
          <div className="flex items-center gap-3 text-red-600 mb-4">
            <AlertCircle size={24} />
            <h1 className="text-2xl font-bold text-gray-900">初始化失败</h1>
          </div>
          <p className="text-gray-600 leading-7 mb-6">{bootstrapError}</p>
          <button
            onClick={() => void bootstrap()}
            className="w-full py-3 rounded-2xl bg-red-600 text-white font-bold hover:bg-red-700 transition-colors"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!session?.authenticated) {
    return (
      <ProtectedNotice
        message={session?.message || '请先通过 Cloudflare Access 完成认证，然后重新打开此页面。'}
        onRetry={() => void bootstrap()}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f6f1] safe-bottom pb-24">
      <Toaster position="top-center" richColors />

      <header className="sticky top-0 z-30 border-b border-gray-200/80 bg-[#f6f6f1]/95 backdrop-blur px-4 py-4">
        <div className="max-w-6xl mx-auto flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-12 h-12 rounded-2xl bg-emerald-700 text-white flex items-center justify-center shadow-lg shadow-emerald-200 shrink-0">
                <BookOpen size={24} />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-gray-900">家藏万卷</h1>
                <p className="text-sm text-gray-500 truncate">{session.email || '未识别用户'}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="hidden sm:inline-flex px-3 py-2 rounded-full bg-white border border-gray-200 text-xs font-semibold text-gray-600">
                {getRuntimeLabel(session)}
              </span>
              <button
                onClick={() => void bootstrap()}
                className="p-3 rounded-full bg-white border border-gray-200 text-gray-500 hover:text-emerald-700 transition-colors"
                title="刷新会话与数据"
              >
                <RefreshCcw size={18} />
              </button>
              <button
                onClick={handleLogout}
                className="p-3 rounded-full bg-white border border-gray-200 text-gray-500 hover:text-red-600 transition-colors"
                title="退出"
              >
                <LogOut size={18} />
              </button>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索书名、作者或 ISBN"
                className="w-full rounded-full bg-white border border-gray-200 pl-11 pr-4 py-3 outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(['全部', '成都', '重庆'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-5 py-2.5 rounded-full text-sm font-semibold transition-all ${
                    activeTab === tab
                      ? 'bg-emerald-700 text-white shadow-md shadow-emerald-200'
                      : 'bg-white text-gray-600 border border-gray-200 hover:border-emerald-200 hover:text-emerald-700'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {session.message && (
            <div className="rounded-2xl bg-white/80 border border-emerald-100 px-4 py-3 text-sm text-gray-600">
              {session.message}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 pt-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="text-sm uppercase tracking-[0.25em] text-gray-400 mb-1">家庭书库</p>
            <h2 className="text-2xl font-bold text-gray-900">共 {filteredBooks.length} 本可见藏书</h2>
          </div>

          {isBooksLoading && (
            <div className="inline-flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="animate-spin" size={16} />
              正在同步
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
          <AnimatePresence mode="popLayout">
            {filteredBooks.map((book) => {
              const coverImageUrl = getCoverImageUrl(book.coverObjectKey, book.coverUrl);

              return (
              <motion.div
                key={book.id}
                layout
                initial={{opacity: 0, scale: 0.96}}
                animate={{opacity: 1, scale: 1}}
                exit={{opacity: 0, scale: 0.96}}
                onClick={() => setActiveBookId((current) => (current === book.id ? null : book.id))}
                className="group relative overflow-hidden rounded-3xl bg-white border border-gray-100 shadow-sm hover:shadow-xl transition-all cursor-pointer"
              >
                <div className="aspect-[3/4] bg-gray-100 relative overflow-hidden">
                  {coverImageUrl ? (
                    <img
                      src={coverImageUrl}
                      alt={book.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      referrerPolicy="no-referrer"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-5 text-center bg-[radial-gradient(circle_at_top,_#f8f0d7,_#ece8de_60%)]">
                      <BookOpen size={42} className="text-emerald-700 mb-3" />
                      <span className="text-sm font-semibold text-gray-600 line-clamp-3">{book.title}</span>
                    </div>
                  )}

                  <div
                    className={`absolute inset-0 bg-black/45 flex items-center justify-center gap-3 transition-opacity ${
                      activeBookId === book.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        openModal(book);
                      }}
                      className="p-3 rounded-full bg-white text-gray-700 hover:text-emerald-700 transition-colors shadow-lg"
                    >
                      <Edit2 size={18} />
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteConfirmId(book.id);
                      }}
                      className="p-3 rounded-full bg-white text-gray-700 hover:text-red-600 transition-colors shadow-lg"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>

                <div className="p-4">
                  <h3 className="font-bold text-gray-900 text-sm line-clamp-2 min-h-[2.5rem]">{book.title}</h3>
                  <div className="mt-2">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold text-white ${book.location === '成都' ? 'bg-sky-600' : 'bg-orange-500'}`}>
                      {book.location}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 mt-2 line-clamp-1">{book.author || '未知作者'}</p>
                  <p className="text-xs text-gray-400 mt-2 line-clamp-1">{book.publisher || '未填写出版社'}{book.year ? ` · ${book.year}` : ''}</p>
                </div>
              </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        {filteredBooks.length === 0 && !isBooksLoading && (
          <div className="text-center py-20">
            <div className="w-20 h-20 rounded-full bg-white border border-gray-200 flex items-center justify-center mx-auto mb-5 shadow-sm">
              <Search size={32} className="text-gray-400" />
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">当前没有匹配的书籍</h3>
            <p className="text-gray-500">试试切换地点、搜索关键词，或者直接添加一本新书。</p>
          </div>
        )}
      </main>

      <button
        onClick={() => openModal()}
        className="fixed right-6 bottom-6 w-16 h-16 rounded-full bg-emerald-700 text-white shadow-2xl shadow-emerald-200 flex items-center justify-center hover:bg-emerald-800 transition-all z-40"
      >
        <Plus size={30} />
      </button>

      <AnimatePresence>
        {deleteConfirmId && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <motion.div
              initial={{opacity: 0}}
              animate={{opacity: 1}}
              exit={{opacity: 0}}
              onClick={() => setDeleteConfirmId(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{opacity: 0, scale: 0.94, y: 10}}
              animate={{opacity: 1, scale: 1, y: 0}}
              exit={{opacity: 0, scale: 0.94, y: 10}}
              className="relative max-w-sm w-full rounded-3xl bg-white p-6 shadow-2xl text-center"
            >
              <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                <Trash2 size={30} className="text-red-600" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">确认删除这本书？</h3>
              <p className="text-gray-500 leading-7 mb-6">删除后不会自动恢复，请确认这本书已经不需要保留在书库中。</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="flex-1 py-3 rounded-2xl bg-gray-100 text-gray-700 font-bold hover:bg-gray-200 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => void handleDelete(deleteConfirmId)}
                  disabled={isDeleting}
                  className="flex-1 py-3 rounded-2xl bg-red-600 text-white font-bold hover:bg-red-700 transition-colors disabled:opacity-60 inline-flex items-center justify-center gap-2"
                >
                  {isDeleting ? <Loader2 className="animate-spin" size={18} /> : '确认删除'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{opacity: 0}}
              animate={{opacity: 1}}
              exit={{opacity: 0}}
              onClick={() => void closeModal()}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />

            <motion.div
              initial={{opacity: 0, scale: 0.96, y: 12}}
              animate={{opacity: 1, scale: 1, y: 0}}
              exit={{opacity: 0, scale: 0.96, y: 12}}
              className="relative w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-[#fbfaf5]">
                <div>
                  <p className="text-xs uppercase tracking-[0.25em] text-gray-400 mb-1">图书表单</p>
                  <h2 className="text-2xl font-bold text-gray-900">{editingBook ? '编辑书籍' : '添加新书'}</h2>
                </div>
                <button onClick={() => void closeModal()} className="p-2 rounded-full hover:bg-gray-200 transition-colors">
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-6">
                <form id="book-form" className="space-y-6" onSubmit={handleSubmit}>
                  <section className="rounded-3xl bg-emerald-50 border border-emerald-100 p-4">
                    <div className="flex items-center justify-between gap-4 mb-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.25em] text-emerald-600 mb-1">ISBN 自动录入</p>
                        <p className="text-sm text-gray-600">扫描或输入 ISBN 后，尝试自动补全标题、作者、出版社和年份。</p>
                      </div>
                      <button
                        type="button"
                        onClick={startScanner}
                        className="shrink-0 px-4 py-3 rounded-2xl bg-emerald-700 text-white font-bold inline-flex items-center gap-2 hover:bg-emerald-800 transition-colors"
                      >
                        <ScanLine size={18} />
                        扫码
                      </button>
                    </div>

                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type="text"
                          value={formData.isbn}
                          onChange={(event) => setFormData({...formData, isbn: event.target.value})}
                          placeholder="输入 ISBN 号"
                          className="w-full rounded-2xl border border-emerald-200 bg-white px-4 py-3 pr-11 outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        <button
                          type="button"
                          onClick={() => void fetchBookInfo(formData.isbn)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-xl text-emerald-700 hover:bg-emerald-50 transition-colors"
                        >
                          <Search size={18} />
                        </button>
                      </div>
                    </div>

                    {isScanning && (
                      <div className="mt-4 rounded-2xl overflow-hidden bg-black relative">
                        <div className="absolute left-3 top-3 right-14 z-10 flex items-center gap-2">
                          <label htmlFor="scanner-camera" className="sr-only">
                            选择摄像头
                          </label>
                          <select
                            id="scanner-camera"
                            value={activeCameraId}
                            onChange={(event) => void handleCameraChange(event.target.value)}
                            disabled={isScannerStarting || cameraOptions.length === 0}
                            className="scanner-select w-full rounded-xl border border-white/25 bg-black/60 px-3 py-2 text-sm text-white outline-none backdrop-blur disabled:opacity-60"
                          >
                            {cameraOptions.length === 0 ? (
                              <option value="">正在加载摄像头...</option>
                            ) : (
                              cameraOptions.map((camera, index) => (
                                <option key={camera.id} value={camera.id}>
                                  {camera.label || `摄像头 ${index + 1}`}
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                        <div id="reader" />
                        {isScannerStarting && (
                          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 text-white">
                            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm backdrop-blur">
                              <Loader2 className="animate-spin" size={16} />
                              正在启动后置摄像头...
                            </div>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => void stopScanner()}
                          className="absolute top-3 right-3 p-2 rounded-full bg-white/20 text-white hover:bg-white/35 transition-colors"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    )}
                  </section>

                  <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs uppercase tracking-[0.25em] text-gray-400 mb-2">书名 *</label>
                        <input
                          required
                          type="text"
                          value={formData.title}
                          onChange={(event) => setFormData({...formData, title: event.target.value})}
                          className="w-full rounded-2xl bg-gray-50 border border-gray-200 px-4 py-3 outline-none focus:bg-white focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs uppercase tracking-[0.25em] text-gray-400 mb-2">作者</label>
                        <input
                          type="text"
                          value={formData.author}
                          onChange={(event) => setFormData({...formData, author: event.target.value})}
                          className="w-full rounded-2xl bg-gray-50 border border-gray-200 px-4 py-3 outline-none focus:bg-white focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs uppercase tracking-[0.25em] text-gray-400 mb-2">出版社</label>
                        <input
                          type="text"
                          value={formData.publisher}
                          onChange={(event) => setFormData({...formData, publisher: event.target.value})}
                          className="w-full rounded-2xl bg-gray-50 border border-gray-200 px-4 py-3 outline-none focus:bg-white focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs uppercase tracking-[0.25em] text-gray-400 mb-2">封面图片</label>
                        <div className="rounded-3xl border border-dashed border-gray-200 bg-gray-50 p-4">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                            <div className="w-full sm:w-36 shrink-0">
                              <div className="aspect-[3/4] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                                {formCoverUrl ? (
                                  <img src={formCoverUrl} alt="封面预览" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_top,_#f8f0d7,_#ece8de_60%)] px-4 text-center text-gray-500">
                                    <Image size={26} className="text-emerald-700" />
                                    <span className="text-xs font-semibold leading-5">上传后会存入 R2</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="flex-1 space-y-3">
                              <input type="file" accept="image/*" onChange={(event) => void handleCoverFileChange(event)} className="hidden" id="cover-upload-input" disabled={!canUploadCover || isUploadingCover} />
                              <div className="flex flex-wrap gap-3">
                                <label
                                  htmlFor="cover-upload-input"
                                  className={`inline-flex cursor-pointer items-center gap-2 rounded-2xl px-4 py-3 font-bold transition-colors ${
                                    canUploadCover
                                      ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                                      : 'bg-gray-200 text-gray-500 cursor-not-allowed'
                                  }`}
                                >
                                  {isUploadingCover ? <Loader2 className="animate-spin" size={18} /> : <Upload size={18} />}
                                  {formCoverUrl ? '更换封面' : '上传封面'}
                                </label>

                                {formCoverUrl && (
                                  <button
                                    type="button"
                                    onClick={() => void handleRemoveCover()}
                                    className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-3 font-bold text-gray-700 border border-gray-200 hover:bg-gray-100 transition-colors"
                                  >
                                    <X size={18} />
                                    移除封面
                                  </button>
                                )}
                              </div>

                              <p className="text-sm leading-6 text-gray-500">
                                {canUploadCover
                                  ? '支持 JPG、PNG、WEBP、GIF、AVIF，单张不超过 10MB。新上传的封面会优先显示，并存入 Cloudflare R2。'
                                  : '当前是 localStorage 模式，只能浏览已有封面；如需上传，请切到 API 模式并启动 Worker + R2。'}
                              </p>

                              {hasLegacyCover && (
                                <p className="text-sm leading-6 text-amber-700">
                                  这本书当前显示的是历史外链封面。上传新封面后会优先使用 R2 中的图片。
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs uppercase tracking-[0.25em] text-gray-400 mb-2">出版年份</label>
                        <input
                          type="text"
                          value={formData.year}
                          onChange={(event) => setFormData({...formData, year: event.target.value})}
                          className="w-full rounded-2xl bg-gray-50 border border-gray-200 px-4 py-3 outline-none focus:bg-white focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs uppercase tracking-[0.25em] text-gray-400 mb-2">ISBN</label>
                        <input
                          type="text"
                          value={formData.isbn}
                          onChange={(event) => setFormData({...formData, isbn: event.target.value})}
                          className="w-full rounded-2xl bg-gray-50 border border-gray-200 px-4 py-3 outline-none focus:bg-white focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs uppercase tracking-[0.25em] text-gray-400 mb-2">所在地</label>
                        <select
                          value={formData.location}
                          onChange={(event) => setFormData({...formData, location: event.target.value as BookDraft['location']})}
                          className="w-full rounded-2xl bg-gray-50 border border-gray-200 px-4 py-3 outline-none focus:bg-white focus:ring-2 focus:ring-emerald-500"
                        >
                          <option value="成都">成都</option>
                          <option value="重庆">重庆</option>
                        </select>
                      </div>
                    </div>
                  </section>
                </form>
              </div>

              <div className="border-t border-gray-100 bg-[#fbfaf5] px-6 py-4 flex gap-3">
                <button
                  type="button"
                  onClick={() => void closeModal()}
                  className="flex-1 py-3 rounded-2xl bg-white border border-gray-200 text-gray-700 font-bold hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  form="book-form"
                  disabled={isSaving}
                  className="flex-[1.4] py-3 rounded-2xl bg-emerald-700 text-white font-bold hover:bg-emerald-800 transition-colors disabled:opacity-60 inline-flex items-center justify-center gap-2"
                >
                  {isSaving ? <Loader2 className="animate-spin" size={18} /> : editingBook ? '保存修改' : '确认添加'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
