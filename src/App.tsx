/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp,
  handleFirestoreError,
  OperationType,
  User 
} from './firebase';
import { 
  Search, 
  Plus, 
  ScanLine, 
  MapPin, 
  Home, 
  LogOut, 
  Trash2, 
  Edit2, 
  X, 
  Loader2, 
  BookOpen,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { Html5QrcodeScanner } from 'html5-qrcode';

// --- Types ---
interface Book {
  id: string;
  title: string;
  author?: string;
  publisher?: string;
  year?: string;
  isbn?: string;
  location: '成都' | '重庆';
  status: '在家' | '不在家';
  coverUrl?: string;
  userId: string;
  createdAt: any;
}

// --- Components ---

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [hasError, setHasError] = useState(false);
  const [errorInfo, setErrorInfo] = useState<any>(null);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (event.error?.message) {
        try {
          const parsed = JSON.parse(event.error.message);
          if (parsed.error && parsed.operationType) {
            setHasError(true);
            setErrorInfo(parsed);
          }
        } catch (e) {
          // Not a JSON error
        }
      }
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-red-50 p-4">
        <div className="bg-white p-6 rounded-2xl shadow-xl max-w-md w-full border border-red-100">
          <div className="flex items-center gap-3 text-red-600 mb-4">
            <AlertCircle size={24} />
            <h2 className="text-xl font-bold">系统错误</h2>
          </div>
          <p className="text-gray-600 mb-4">操作失败: {errorInfo?.operationType} @ {errorInfo?.path}</p>
          <pre className="bg-gray-100 p-3 rounded text-xs overflow-auto mb-4 max-h-40">
            {errorInfo?.error}
          </pre>
          <button 
            onClick={() => window.location.reload()}
            className="w-full py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [books, setBooks] = useState<Book[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'全部' | '成都' | '重庆'>('全部');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeBookId, setActiveBookId] = useState<string | null>(null); // For mobile tap to show actions

  // Form State
  const [formData, setFormData] = useState({
    title: '',
    author: '',
    publisher: '',
    year: '',
    isbn: '',
    location: '成都' as '成都' | '重庆',
    status: '在家' as '在家' | '不在家',
    coverUrl: ''
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;

    const q = query(collection(db, 'books'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const booksData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Book[];
      setBooks(booksData.sort((a, b) => b.createdAt?.seconds - a.createdAt?.seconds));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'books');
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const userRef = doc(db, 'users', result.user.uid);
      const userSnap = await getDoc(userRef);
      
      if (!userSnap.exists()) {
        await setDoc(userRef, {
          email: result.user.email,
          role: 'user'
        });
      }
      toast.success('登录成功');
    } catch (error) {
      toast.error('登录失败');
    }
  };

  const handleLogout = () => signOut(auth);

  const fetchBookInfo = async (isbn: string) => {
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    if (!cleanIsbn) return;

    toast.loading('正在获取书籍信息...', { id: 'isbn-fetch' });
    
    try {
      // 1. Try Google Books API first (Better Chinese support)
      const googleResponse = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`);
      const googleData = await googleResponse.json();
      
      if (googleData.items && googleData.items.length > 0) {
        const info = googleData.items[0].volumeInfo;
        setFormData(prev => ({
          ...prev,
          title: info.title || '',
          author: info.authors?.join(', ') || '',
          publisher: info.publisher || '',
          year: info.publishedDate || '',
          isbn: cleanIsbn,
          coverUrl: info.imageLinks?.thumbnail?.replace('http:', 'https:') || ''
        }));
        toast.success('获取成功 (Google Books)', { id: 'isbn-fetch' });
        return;
      }

      // 2. Fallback to Open Library
      const olResponse = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`);
      const olData = await olResponse.json();
      const bookData = olData[`ISBN:${cleanIsbn}`];

      if (bookData) {
        setFormData(prev => ({
          ...prev,
          title: bookData.title || '',
          author: bookData.authors?.map((a: any) => a.name).join(', ') || '',
          publisher: bookData.publishers?.map((p: any) => p.name).join(', ') || '',
          year: bookData.publish_date || '',
          isbn: cleanIsbn,
          coverUrl: bookData.cover?.large || bookData.cover?.medium || ''
        }));
        toast.success('获取成功 (Open Library)', { id: 'isbn-fetch' });
      } else {
        toast.error('未找到该书籍信息，请手动录入', { id: 'isbn-fetch' });
      }
    } catch (error) {
      console.error('Fetch error:', error);
      toast.error('网络请求失败，请手动输入', { id: 'isbn-fetch' });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    try {
      if (editingBook) {
        await updateDoc(doc(db, 'books', editingBook.id), {
          ...formData,
          updatedAt: serverTimestamp()
        });
        toast.success('更新成功');
      } else {
        await addDoc(collection(db, 'books'), {
          ...formData,
          userId: user.uid,
          createdAt: serverTimestamp()
        });
        toast.success('添加成功');
      }
      closeModal();
    } catch (error) {
      handleFirestoreError(error, editingBook ? OperationType.UPDATE : OperationType.CREATE, 'books');
    }
  };

  const handleDelete = async (id: string) => {
    setIsDeleting(true);
    try {
      await deleteDoc(doc(db, 'books', id));
      toast.success('删除成功');
      setDeleteConfirmId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `books/${id}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const openModal = (book?: Book) => {
    if (book) {
      setEditingBook(book);
      setFormData({
        title: book.title,
        author: book.author || '',
        publisher: book.publisher || '',
        year: book.year || '',
        isbn: book.isbn || '',
        location: book.location,
        status: book.status,
        coverUrl: book.coverUrl || ''
      });
    } else {
      setEditingBook(null);
      setFormData({
        title: '',
        author: '',
        publisher: '',
        year: '',
        isbn: '',
        location: activeTab === '全部' ? '成都' : activeTab,
        status: '在家',
        coverUrl: ''
      });
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setIsScanning(false);
    setEditingBook(null);
  };

  const startScanner = () => {
    setIsScanning(true);
    setTimeout(() => {
      const scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 }, false);
      scanner.render((decodedText) => {
        scanner.clear();
        setIsScanning(false);
        fetchBookInfo(decodedText);
      }, (error) => {
        // console.warn(error);
      });
    }, 100);
  };

  const filteredBooks = books.filter(book => {
    const matchesSearch = book.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          book.author?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          book.isbn?.includes(searchQuery);
    const matchesTab = activeTab === '全部' || book.location === activeTab;
    return matchesSearch && matchesTab;
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="animate-spin text-green-600" size={48} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#f6f6f1] p-6">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center max-w-md w-full bg-white p-10 rounded-3xl shadow-xl border border-gray-100"
        >
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <BookOpen size={40} className="text-green-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">家藏万卷</h1>
          <p className="text-gray-500 mb-8">简洁、优雅的家庭藏书管理系统</p>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-green-600 text-white rounded-xl font-bold text-lg shadow-lg shadow-green-200 hover:bg-green-700 transition-all active:scale-95 flex items-center justify-center gap-3"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5 bg-white rounded-full p-0.5" alt="Google" />
            使用 Google 账号登录
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#f6f6f1] pb-24">
        <Toaster position="top-center" richColors />
        
        {/* Header */}
        <header className="bg-white border-b border-gray-200 sticky top-0 z-30 px-4 py-4">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 bg-green-600 rounded-xl flex items-center justify-center shadow-md shadow-green-100">
                <BookOpen size={24} className="text-white" />
              </div>
              <h1 className="text-xl font-bold text-gray-900 hidden sm:block">家藏万卷</h1>
            </div>

            <div className="flex-1 max-w-md mx-4 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input 
                type="text" 
                placeholder="搜索书名、作者、ISBN..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-gray-100 border-transparent focus:bg-white focus:ring-2 focus:ring-green-500 rounded-full transition-all outline-none text-sm"
              />
            </div>

            <button 
              onClick={handleLogout}
              className="p-2 text-gray-400 hover:text-red-500 transition-colors"
              title="退出登录"
            >
              <LogOut size={20} />
            </button>
          </div>
        </header>

        {/* Tabs */}
        <div className="max-w-5xl mx-auto px-4 mt-6">
          <div className="flex gap-2 p-1 bg-gray-200/50 rounded-xl w-fit">
            {(['全部', '成都', '重庆'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab 
                    ? 'bg-white text-green-700 shadow-sm' 
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Book Grid */}
        <main className="max-w-5xl mx-auto px-4 mt-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
            <AnimatePresence mode="popLayout">
              {filteredBooks.map((book) => (
                <motion.div 
                  key={book.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  onClick={() => setActiveBookId(activeBookId === book.id ? null : book.id)}
                  className="group relative bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl transition-all border border-gray-100 cursor-pointer"
                >
                  <div className="aspect-[3/4] bg-gray-100 relative overflow-hidden">
                    {book.coverUrl ? (
                      <img 
                        src={book.coverUrl} 
                        alt={book.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center">
                        <BookOpen size={40} className="text-gray-300 mb-2" />
                        <span className="text-xs text-gray-400 font-medium">{book.title}</span>
                      </div>
                    )}
                    
                    {/* Status Badges */}
                    <div className="absolute top-2 left-2 flex flex-col gap-1">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white shadow-sm ${
                        book.location === '成都' ? 'bg-blue-500' : 'bg-orange-500'
                      }`}>
                        {book.location}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white shadow-sm ${
                        book.status === '在家' ? 'bg-green-500' : 'bg-red-500'
                      }`}>
                        {book.status}
                      </span>
                    </div>

                    {/* Actions Overlay - Improved for Mobile */}
                    <div className={`absolute inset-0 bg-black/40 transition-opacity flex items-center justify-center gap-3 ${
                      activeBookId === book.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}>
                      <button 
                        onClick={(e) => { e.stopPropagation(); openModal(book); }}
                        className="p-3 bg-white rounded-full text-gray-700 hover:text-green-600 transition-colors shadow-lg active:scale-90"
                      >
                        <Edit2 size={18} />
                      </button>
                      <button 
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(book.id); }}
                        className="p-3 bg-white rounded-full text-gray-700 hover:text-red-600 transition-colors shadow-lg active:scale-90"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                  
                  <div className="p-3">
                    <h3 className="font-bold text-gray-900 text-sm line-clamp-1 mb-0.5">{book.title}</h3>
                    <p className="text-xs text-gray-500 line-clamp-1">{book.author || '未知作者'}</p>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {filteredBooks.length === 0 && (
            <div className="text-center py-20">
              <div className="w-20 h-20 bg-gray-200 rounded-full flex items-center justify-center mx-auto mb-4">
                <Search size={32} className="text-gray-400" />
              </div>
              <p className="text-gray-500">没有找到相关书籍</p>
            </div>
          )}
        </main>

        {/* Floating Action Button */}
        <button 
          onClick={() => openModal()}
          className="fixed bottom-8 right-8 w-16 h-16 bg-green-600 text-white rounded-full shadow-2xl shadow-green-300 flex items-center justify-center hover:bg-green-700 hover:scale-110 active:scale-95 transition-all z-40"
        >
          <Plus size={32} />
        </button>

        {/* Delete Confirmation Modal */}
        <AnimatePresence>
          {deleteConfirmId && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setDeleteConfirmId(null)}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="relative bg-white p-6 rounded-3xl shadow-2xl max-w-sm w-full text-center"
              >
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Trash2 size={32} className="text-red-600" />
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">确认删除？</h3>
                <p className="text-gray-500 mb-6">此操作无法撤销，确定要从藏书中移除这本书吗？</p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setDeleteConfirmId(null)}
                    className="flex-1 py-3 bg-gray-100 text-gray-700 rounded-xl font-bold hover:bg-gray-200 transition-all"
                  >
                    取消
                  </button>
                  <button 
                    onClick={() => handleDelete(deleteConfirmId)}
                    disabled={isDeleting}
                    className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all flex items-center justify-center gap-2"
                  >
                    {isDeleting ? <Loader2 className="animate-spin" size={20} /> : '确认删除'}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Modal */}
        <AnimatePresence>
          {isModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={closeModal}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              />
              
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
              >
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
                  <h2 className="text-xl font-bold text-gray-900">
                    {editingBook ? '编辑书籍' : '添加新书'}
                  </h2>
                  <button onClick={closeModal} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                    <X size={20} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                  <form id="book-form" onSubmit={handleSubmit} className="space-y-6">
                    {/* ISBN & Scanner */}
                    <div className="bg-green-50 p-4 rounded-2xl border border-green-100">
                      <label className="block text-xs font-bold text-green-700 uppercase tracking-wider mb-2">ISBN 扫码录入</label>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <input 
                            type="text" 
                            placeholder="输入 ISBN 号..."
                            value={formData.isbn}
                            onChange={(e) => setFormData({...formData, isbn: e.target.value})}
                            className="w-full pl-4 pr-12 py-3 bg-white border border-green-200 rounded-xl outline-none focus:ring-2 focus:ring-green-500 transition-all"
                          />
                          <button 
                            type="button"
                            onClick={() => fetchBookInfo(formData.isbn)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                          >
                            <Search size={20} />
                          </button>
                        </div>
                        <button 
                          type="button"
                          onClick={startScanner}
                          className="px-4 bg-green-600 text-white rounded-xl hover:bg-green-700 transition-colors flex items-center gap-2"
                        >
                          <ScanLine size={20} />
                          <span className="hidden sm:inline">扫码</span>
                        </button>
                      </div>
                      
                      {isScanning && (
                        <div className="mt-4 rounded-xl overflow-hidden bg-black aspect-video relative">
                          <div id="reader"></div>
                          <button 
                            onClick={() => setIsScanning(false)}
                            className="absolute top-2 right-2 p-2 bg-white/20 hover:bg-white/40 text-white rounded-full backdrop-blur-md"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 ml-1">书名 *</label>
                          <input 
                            required
                            type="text" 
                            value={formData.title}
                            onChange={(e) => setFormData({...formData, title: e.target.value})}
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:ring-2 focus:ring-green-500 transition-all"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 ml-1">作者</label>
                          <input 
                            type="text" 
                            value={formData.author}
                            onChange={(e) => setFormData({...formData, author: e.target.value})}
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:ring-2 focus:ring-green-500 transition-all"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 ml-1">出版社</label>
                          <input 
                            type="text" 
                            value={formData.publisher}
                            onChange={(e) => setFormData({...formData, publisher: e.target.value})}
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:ring-2 focus:ring-green-500 transition-all"
                          />
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 ml-1">出版年份</label>
                          <input 
                            type="text" 
                            value={formData.year}
                            onChange={(e) => setFormData({...formData, year: e.target.value})}
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:ring-2 focus:ring-green-500 transition-all"
                          />
                        </div>
                        
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 ml-1">所在地</label>
                            <select 
                              value={formData.location}
                              onChange={(e) => setFormData({...formData, location: e.target.value as any})}
                              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:ring-2 focus:ring-green-500 transition-all appearance-none"
                            >
                              <option value="成都">成都</option>
                              <option value="重庆">重庆</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 ml-1">状态</label>
                            <select 
                              value={formData.status}
                              onChange={(e) => setFormData({...formData, status: e.target.value as any})}
                              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:ring-2 focus:ring-green-500 transition-all appearance-none"
                            >
                              <option value="在家">在家</option>
                              <option value="不在家">不在家</option>
                            </select>
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 ml-1">封面图片 URL</label>
                          <input 
                            type="text" 
                            value={formData.coverUrl}
                            onChange={(e) => setFormData({...formData, coverUrl: e.target.value})}
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:ring-2 focus:ring-green-500 transition-all"
                          />
                        </div>
                      </div>
                    </div>
                  </form>
                </div>

                <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex gap-3">
                  <button 
                    type="button"
                    onClick={closeModal}
                    className="flex-1 py-3 bg-white border border-gray-200 text-gray-700 rounded-xl font-bold hover:bg-gray-50 transition-all active:scale-95"
                  >
                    取消
                  </button>
                  <button 
                    type="submit"
                    form="book-form"
                    className="flex-[2] py-3 bg-green-600 text-white rounded-xl font-bold shadow-lg shadow-green-100 hover:bg-green-700 transition-all active:scale-95"
                  >
                    {editingBook ? '保存修改' : '确认添加'}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  );
}
