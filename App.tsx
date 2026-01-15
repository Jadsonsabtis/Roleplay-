
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Character, Message, CharacterCategory, ChatHistoryEntry, ThemeType } from './types';
import { DEFAULT_CHARACTERS, THEME_AUDIO, DEFAULT_BG } from './constants';
import { callGemini, generateSpeech } from './services/gemini';

// --- HELPERS DE ÁUDIO ---
function decodeBase64(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext): Promise<AudioBuffer> {
  const sampleRate = 24000;
  const numChannels = 1;
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const CloudDB = {
  async getCharacters(): Promise<Character[]> {
    const cloudData = JSON.parse(localStorage.getItem('cloud_characters') || '[]');
    const normalizedDefault = DEFAULT_CHARACTERS.map(c => ({
      ...c, 
      id: String(c.id), 
      authorId: 'system', 
      isPublic: true,
      voiceType: c.gender === 'female' ? 'female' : 'male',
      franchise: (c as any).franchise || 'Multiverso',
      voiceFilter: 'Natural'
    }));
    return [...normalizedDefault, ...cloudData];
  },

  async saveCharacter(char: Character): Promise<void> {
    const cloudData = JSON.parse(localStorage.getItem('cloud_characters') || '[]');
    localStorage.setItem('cloud_characters', JSON.stringify([...cloudData, char]));
  },

  async getChatMessages(userId: string, characterId: string): Promise<Message[]> {
    const allChats = JSON.parse(localStorage.getItem('cloud_chats_private') || '{}');
    const chatId = `${userId}_${characterId}`;
    return allChats[chatId] || [];
  },

  async saveChatMessages(userId: string, characterId: string, messages: Message[]): Promise<void> {
    const allChats = JSON.parse(localStorage.getItem('cloud_chats_private') || '{}');
    const chatId = `${userId}_${characterId}`;
    allChats[chatId] = messages;
    localStorage.setItem('cloud_chats_private', JSON.stringify(allChats));
  },

  async getRecentList(userId: string): Promise<ChatHistoryEntry[]> {
    return JSON.parse(localStorage.getItem(`cloud_recent_${userId}`) || '[]');
  },

  async updateRecentList(userId: string, entry: ChatHistoryEntry): Promise<void> {
    let list = JSON.parse(localStorage.getItem(`cloud_recent_${userId}`) || '[]');
    list = list.filter((item: ChatHistoryEntry) => item.charId !== entry.charId);
    list.unshift(entry);
    localStorage.setItem(`cloud_recent_${userId}`, JSON.stringify(list.slice(0, 20)));
  }
};

const formatMsg = (text: string) => {
  const parts = text.split(/(\*[^*]+\*)/g);
  return parts.map((part, i) => 
    part.startsWith('*') && part.endsWith('*') ? 
    <span key={i} className="action-text">{part}</span> : 
    part
  );
};

const App: React.FC = () => {
  const [loginStep, setLoginStep] = useState<'email' | 'nick' | 'ready'>('email');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [tempEmail, setTempEmail] = useState('');

  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeTab, setActiveTab] = useState<'global' | 'mine'>('global');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<CharacterCategory>('all');
  const [recentConvs, setRecentConvs] = useState<ChatHistoryEntry[]>([]);
  
  const [currentChar, setCurrentChar] = useState<Character | null>(null);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);

  const [activeModal, setActiveModal] = useState<'intro' | 'create' | 'settings' | null>(null);
  const [selectedChar, setSelectedChar] = useState<Character | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isPlayingTheme, setIsPlayingTheme] = useState(false);
  
  const [playingVoiceId, setPlayingVoiceId] = useState<number | null>(null);
  const [loadingVoiceId, setLoadingVoiceId] = useState<number | null>(null);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const themeAudioRef = useRef<HTMLAudioElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedUser = localStorage.getItem('rp_user');
    if (savedUser) {
      const user = JSON.parse(savedUser);
      setCurrentUser(user);
      setLoginStep('ready');
      syncUserData(user.email);
    }
    syncGlobalGallery();
  }, []);

  const syncGlobalGallery = async () => {
    const chars = await CloudDB.getCharacters();
    setCharacters(chars);
  };

  const syncUserData = async (email: string) => {
    const recent = await CloudDB.getRecentList(email);
    setRecentConvs(recent);
  };

  // Fix: Implemented missing login flow handlers
  const handleEmailStep = (email: string) => {
    if (!email.trim()) return;
    setTempEmail(email);
    setLoginStep('nick');
  };

  const handleNickStep = (nick: string) => {
    if (!nick.trim()) return;
    const user: User = {
      email: tempEmail,
      name: nick,
      initial: nick.charAt(0).toUpperCase()
    };
    localStorage.setItem('rp_user', JSON.stringify(user));
    setCurrentUser(user);
    setLoginStep('ready');
    syncUserData(user.email);
  };

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages, isSending, scrollToBottom]);

  const handleVoicePlay = async (text: string, idx: number) => {
    if (!currentChar) return;
    if (playingVoiceId === idx) {
      voiceSourceRef.current?.stop();
      setPlayingVoiceId(null);
      return;
    }

    setLoadingVoiceId(idx);
    const audioData = await generateSpeech(text, currentChar);
    setLoadingVoiceId(null);

    if (audioData) {
      if (!voiceAudioContextRef.current) {
        voiceAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      
      const ctx = voiceAudioContextRef.current;
      const bytes = decodeBase64(audioData);
      const buffer = await decodeAudioData(bytes, ctx);
      
      voiceSourceRef.current?.stop();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => setPlayingVoiceId(null);
      source.start();
      voiceSourceRef.current = source;
      setPlayingVoiceId(idx);
    }
  };

  const startPrivateChat = async (char: Character) => {
    if (!currentUser) return;
    setCurrentChar(char);
    setActiveModal(null);
    setIsSidebarOpen(false);
    
    const history = await CloudDB.getChatMessages(currentUser.email, char.id);
    if (history.length === 0) {
      const initial: Message = { 
        role: 'assistant', 
        content: char.greeting, 
        timestamp: Date.now() 
      };
      setChatMessages([initial]);
      await CloudDB.saveChatMessages(currentUser.email, char.id, [initial]);
    } else {
      setChatMessages(history);
    }
    initAudio(char.theme);
  };

  const sendMessage = async (text: string) => {
    if (!currentChar || !currentUser || isSending) return;
    if (!text.trim() && !pendingImage) return;

    const userMsg: Message = { 
      role: 'user', 
      content: text, 
      type: pendingImage ? 'image' : 'text',
      timestamp: Date.now() 
    };
    
    const updatedHistory = [...chatMessages, userMsg];
    setChatMessages(updatedHistory);
    setIsSending(true);
    const imgData = pendingImage || undefined;
    setPendingImage(null);

    try {
      const response = await callGemini(currentChar, text, chatMessages, imgData);
      const assistantMsg: Message = { 
        role: 'assistant', 
        content: response, 
        timestamp: Date.now() 
      };
      
      const finalHistory = [...updatedHistory, assistantMsg];
      setChatMessages(finalHistory);
      await CloudDB.saveChatMessages(currentUser.email, currentChar.id, finalHistory);
      
      const entry: ChatHistoryEntry = {
        charId: currentChar.id,
        lastMsg: response.slice(0, 40) + '...',
        timestamp: Date.now()
      };
      await CloudDB.updateRecentList(currentUser.email, entry);
      syncUserData(currentUser.email);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSending(false);
    }
  };

  const publishBot = async (formData: any) => {
    if (!currentUser) return;
    const newChar: Character = {
      id: `cloud_bot_${Date.now()}`,
      authorId: currentUser.email,
      name: formData.name,
      franchise: formData.franchise,
      gender: 'other',
      desc: '',
      traits: formData.traits,
      avatar: formData.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${Date.now()}`,
      category: formData.category,
      theme: formData.theme,
      personality: formData.personality,
      greeting: formData.greeting,
      isPublic: true,
      voiceType: formData.voiceType,
      voiceFilter: formData.voiceFilter
    };

    await CloudDB.saveCharacter(newChar);
    await syncGlobalGallery();
    setActiveModal(null);
  };

  const initAudio = (theme: ThemeType) => {
    stopAudio();
    const url = THEME_AUDIO[theme] || THEME_AUDIO.fantasy;
    themeAudioRef.current = new Audio(url);
    themeAudioRef.current.loop = true;
    themeAudioRef.current.volume = 0.15;
  };

  const toggleAudio = () => {
    if (!themeAudioRef.current) return;
    if (isPlayingTheme) themeAudioRef.current.pause();
    else themeAudioRef.current.play().catch(() => {});
    setIsPlayingTheme(!isPlayingTheme);
  };

  const stopAudio = () => {
    if (themeAudioRef.current) { themeAudioRef.current.pause(); themeAudioRef.current = null; }
    setIsPlayingTheme(false);
    voiceSourceRef.current?.stop();
    setPlayingVoiceId(null);
  };

  const filteredChars = characters.filter(c => {
    const tabMatch = activeTab === 'global' || c.authorId === currentUser?.email;
    const catMatch = activeCategory === 'all' || c.category === activeCategory;
    const searchMatch = c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.franchise.toLowerCase().includes(searchQuery.toLowerCase());
    return tabMatch && catMatch && searchMatch;
  });

  if (loginStep !== 'ready' || !currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#020205]">
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass-card rounded-[32px] p-10 w-full max-w-sm border-white/5 shadow-2xl">
          <div className="w-14 h-14 mx-auto mb-6 rounded-2xl btn-primary flex items-center justify-center shadow-lg"><svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div>
          <h1 className="text-2xl font-black text-center gradient-text mb-2">RolePlay Online</h1>
          <AnimatePresence mode="wait">
            {loginStep === 'email' ? (
              <motion.div key="e" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
                <input autoFocus type="email" placeholder="Seu Gmail..." className="w-full input-dark rounded-xl p-4 text-sm" onKeyDown={(e) => e.key === 'Enter' && handleEmailStep((e.target as HTMLInputElement).value)} />
                <button onClick={(e) => handleEmailStep((e.currentTarget.previousSibling as HTMLInputElement).value)} className="w-full py-4 rounded-xl btn-primary font-bold text-xs uppercase tracking-widest shadow-xl">Entrar na Rede</button>
              </motion.div>
            ) : (
              <motion.div key="n" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
                <input autoFocus type="text" placeholder="Como quer ser chamado?" className="w-full input-dark rounded-xl p-4 text-sm" onKeyDown={(e) => e.key === 'Enter' && handleNickStep((e.target as HTMLInputElement).value)} />
                <button onClick={(e) => handleNickStep((e.currentTarget.previousSibling as HTMLInputElement).value)} className="w-full py-4 rounded-xl btn-primary font-bold text-xs uppercase tracking-widest shadow-xl">Conectar</button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#020205] text-slate-300">
      
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            onClick={() => setIsSidebarOpen(false)} 
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] lg:hidden" 
          />
        )}
      </AnimatePresence>

      <aside className={`fixed top-0 left-0 w-72 h-full glass z-[201] transition-all duration-300 flex flex-col border-r border-white/10 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0 lg:w-20 lg:hover:w-72 group'}`}>
        <div className="p-5 border-b border-white/5 flex items-center justify-between overflow-hidden">
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 min-w-[40px] rounded-xl btn-primary flex items-center justify-center">
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
             </div>
             <span className="font-black text-lg gradient-text opacity-0 group-hover:opacity-100 transition-all duration-300 whitespace-nowrap">SUPER RP</span>
          </div>
          <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden p-2 text-slate-500 hover:text-white rounded-lg transition-colors">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        
        <div className="p-5 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 min-w-[44px] rounded-xl btn-primary flex items-center justify-center font-black text-xl shadow-lg">{currentUser.initial}</div>
            <div className="min-w-0 opacity-0 group-hover:opacity-100 transition-all duration-300">
              <p className="font-bold text-sm text-white truncate">{currentUser.name}</p>
              <p className="text-[9px] text-purple-400 font-black uppercase truncate">Sincronizado</p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 scroll-hide space-y-4">
          <div className="space-y-1">
            <p className="px-3 py-2 text-[9px] font-black text-slate-600 uppercase tracking-widest opacity-0 group-hover:opacity-100">Portal</p>
            <button onClick={() => { setActiveTab('global'); setIsSidebarOpen(false); setCurrentChar(null); }} className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 text-slate-400">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
              <span className="text-xs font-bold opacity-0 group-hover:opacity-100">Multiverso</span>
            </button>
          </div>

          <div className="space-y-1">
            <p className="px-3 py-2 text-[9px] font-black text-slate-600 uppercase tracking-widest opacity-0 group-hover:opacity-100">Conversas Privadas</p>
            {recentConvs.map(chat => {
              const char = characters.find(c => c.id === chat.charId);
              if (!char) return null;
              return (
                <button key={char.id} onClick={() => startPrivateChat(char)} className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-white/5 text-left group/item transition-all">
                  <img src={char.avatar} className="w-10 h-10 min-w-[40px] rounded-xl object-cover border border-white/10" />
                  <div className="min-w-0 opacity-0 group-hover:opacity-100 transition-all duration-300">
                    <p className="font-bold text-slate-200 text-xs truncate">{char.name}</p>
                    <p className="text-[10px] text-slate-500 truncate leading-tight">{chat.lastMsg}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-4 space-y-2 border-t border-white/5">
          <button onClick={() => { setActiveModal('create'); setIsSidebarOpen(false); }} className="w-full h-12 rounded-2xl btn-primary font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"/></svg>
            <span className="opacity-0 group-hover:opacity-100 transition-opacity">NOVA ENTIDADE</span>
          </button>
        </div>
      </aside>

      <main className="lg:pl-20 min-h-screen">
        <AnimatePresence mode="wait">
          {!currentChar ? (
            <motion.div key="h" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pt-24 px-4 max-w-6xl mx-auto">
              <header className="fixed top-0 left-0 lg:left-20 right-0 glass z-50 px-6 py-4 flex items-center justify-between border-b border-white/5">
                <div className="flex items-center gap-4">
                  <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2.5 bg-white/5 rounded-xl"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16"/></svg></button>
                  <h1 className="text-sm font-black text-white uppercase tracking-[0.2em]">{activeTab === 'global' ? 'Galeria Pública' : 'Minhas IAs'}</h1>
                </div>
              </header>

              <div className="mb-8 relative max-w-2xl">
                <input type="text" placeholder="Franquia, personagem ou autor..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full glass-card rounded-2xl p-5 pl-14 text-sm input-dark border-white/5" />
                <svg className="absolute left-5 top-1/2 -translate-y-1/2 w-6 h-6 text-purple-500/40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {filteredChars.map(char => (
                  <div key={char.id} onClick={() => { setSelectedChar(char); setActiveModal('intro'); }} className="group glass-card rounded-[28px] overflow-hidden cursor-pointer shadow-lg border-white/5 hover:border-purple-500/50 transition-all">
                    <div className="aspect-[3/4] relative overflow-hidden">
                      <img src={char.avatar} loading="lazy" className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/95 to-transparent" />
                      <div className="absolute bottom-4 left-4 right-4">
                        <p className="text-[8px] font-black text-purple-400 uppercase tracking-widest mb-1">{char.franchise}</p>
                        <h4 className="text-sm font-black text-white truncate">{char.name}</h4>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div key="c" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 lg:left-20 flex flex-col bg-[#020205] z-[300]">
              <div className="absolute inset-0 bg-cover bg-center opacity-10 pointer-events-none" style={{ backgroundImage: `url(${currentChar.background || DEFAULT_BG[currentChar.theme] || DEFAULT_BG.fantasy})` }} />
              
              <header className="relative z-10 p-4 glass border-b border-white/10 flex items-center justify-between">
                 <div className="flex items-center gap-4">
                   <button onClick={() => { setCurrentChar(null); stopAudio(); syncUserData(currentUser.email); }} className="p-2.5 hover:bg-white/5 rounded-xl"><svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"/></svg></button>
                   <img src={currentChar.avatar} className="w-11 h-11 rounded-xl object-cover border-2 border-purple-500/20" />
                   <div>
                     <h3 className="text-sm font-black text-white">{currentChar.name}</h3>
                     <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">{currentChar.franchise}</p>
                   </div>
                 </div>
                 <button onClick={toggleAudio} className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${isPlayingTheme ? 'btn-primary' : 'bg-white/5 text-slate-500'}`}><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 8.464a5 5 0 010 7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/></svg></button>
              </header>

              <div className="flex-1 overflow-y-auto p-5 space-y-7 relative z-10 scroll-hide pb-32">
                {chatMessages.map((msg, idx) => (
                  <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'assistant' && <img src={currentChar.avatar} className="w-9 h-9 rounded-xl mr-3 self-end shadow-md border border-white/10" />}
                    <div className="flex flex-col gap-1 max-w-[85%]">
                      <div className={`px-5 py-4 rounded-3xl text-[13px] leading-[1.6] shadow-2xl ${msg.role === 'user' ? 'chat-user rounded-br-none' : 'chat-ai rounded-bl-none border border-white/5'}`}>
                        {msg.type === 'image' && <img src={msg.content} className="max-w-full rounded-2xl mb-4 border border-white/10" />}
                        <div className="prose prose-invert prose-sm max-w-none">{formatMsg(msg.content)}</div>
                      </div>
                      
                      {msg.role === 'assistant' && (
                        <button 
                          onClick={() => handleVoicePlay(msg.content, idx)}
                          className={`self-start mt-1 flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 transition-all ${playingVoiceId === idx ? 'text-purple-400' : 'text-slate-500'}`}
                        >
                          {loadingVoiceId === idx ? <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" /> : playingVoiceId === idx ? <div className="flex gap-0.5 h-3 items-end"><div className="w-0.5 bg-purple-500 h-full animate-bounce" /><div className="w-0.5 bg-purple-500 h-1/2 animate-bounce" /></div> : <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M13.5 4.06c-.22-.02-.44.05-.61.19l-4.5 3.75H5.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.89l4.5 3.75c.17.14.39.21.61.19.22-.02.43-.13.56-.31.13-.18.19-.41.19-.63V5c0-.22-.06-.45-.19-.63-.13-.18-.34-.29-.56-.31zM19 12c0-1.73-1.02-3.21-2.5-3.88v7.77c1.48-.67 2.5-2.15 2.5-3.89zM16.5 5.5v1.54C19.15 7.72 21 10.15 21 13s-1.85 5.28-4.5 5.96v1.54C20 19.78 22.5 16.68 22.5 13s-2.5-6.78-6-7.5z"/></svg>}
                          <span className="text-[10px] font-black uppercase tracking-widest">{playingVoiceId === idx ? 'Parar' : 'Sintonizar Voz'}</span>
                        </button>
                      )}
                    </div>
                  </motion.div>
                ))}
                {isSending && (
                  <div className="flex justify-start gap-3 items-center"><img src={currentChar.avatar} className="w-9 h-9 rounded-xl opacity-20 grayscale" /><div className="chat-ai px-6 py-4 rounded-3xl rounded-bl-none flex gap-1.5"><div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" /><div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce [animation-delay:0.1s]" /><div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce [animation-delay:0.2s]" /></div></div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="absolute bottom-0 left-0 right-0 p-5 bg-gradient-to-t from-black to-transparent z-20">
                <div className="max-w-4xl mx-auto glass-card rounded-[28px] p-3 flex gap-3 items-end border-white/10">
                  <textarea 
                    placeholder="Mande sua mensagem..." 
                    className="flex-1 bg-transparent border-none outline-none resize-none text-sm p-3.5 max-h-40 text-slate-200" 
                    rows={1} 
                    onInput={(e) => {
                      const target = e.target as HTMLTextAreaElement;
                      target.style.height = 'auto';
                      target.style.height = `${target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const val = (e.target as HTMLTextAreaElement).value;
                        if (val.trim()) {
                          sendMessage(val);
                          (e.target as HTMLTextAreaElement).value = '';
                          (e.target as HTMLTextAreaElement).style.height = 'auto';
                        }
                      }
                    }} 
                  />
                  <button onClick={(e) => { 
                    const area = e.currentTarget.parentElement?.querySelector('textarea') as HTMLTextAreaElement; 
                    if (area.value.trim()) {
                      sendMessage(area.value); 
                      area.value = ''; 
                    }
                  }} disabled={isSending} className="w-12 h-12 min-w-[48px] btn-primary rounded-2xl flex items-center justify-center shadow-2xl active:scale-90 transition-all">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Modal Criar Personagem - Super Cérebro Edition */}
        <AnimatePresence>
          {activeModal === 'create' && (
            <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setActiveModal(null)} className="absolute inset-0 bg-black/95 backdrop-blur-2xl" />
              <motion.div initial={{ opacity: 0, y: 60 }} animate={{ opacity: 1, y: 0 }} className="glass-card rounded-[48px] w-full max-w-xl p-10 relative z-10 border-white/5 overflow-y-auto max-h-[95vh] scroll-hide">
                <h3 className="text-3xl font-black gradient-text uppercase tracking-tighter mb-10 text-center">Manifestar Nova IA</h3>
                
                <form className="space-y-6" onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  publishBot({
                    name: fd.get('name'),
                    franchise: fd.get('franchise'),
                    traits: fd.get('traits'),
                    personality: fd.get('personality'),
                    greeting: fd.get('greeting'),
                    category: fd.get('category'),
                    theme: fd.get('theme'),
                    voiceType: fd.get('voiceType'),
                    voiceFilter: fd.get('voiceFilter')
                  });
                }}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <input name="name" placeholder="Nome do Personagem" className="w-full input-dark rounded-xl p-4 text-xs" required />
                    <input name="franchise" placeholder="Franquia (Ex: Marvel, Naruto...)" className="w-full input-dark rounded-xl p-4 text-xs" required />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <select name="voiceType" className="w-full input-dark rounded-xl p-4 text-xs bg-[#0a0a15] appearance-none">
                       <option value="female">Voz Feminina (Base)</option>
                       <option value="male">Voz Masculina (Base)</option>
                    </select>
                    <input name="voiceFilter" placeholder="Filtro de Voz (Ex: Rouco, Heróico...)" className="w-full input-dark rounded-xl p-4 text-xs" />
                  </div>

                  <div className="space-y-2">
                     <label className="text-[10px] font-black text-slate-500 uppercase ml-4">Codificação de DNA (Traços)</label>
                     <input name="traits" placeholder="Frio, leal, engraçado..." className="w-full input-dark rounded-xl p-4 text-xs" required />
                  </div>

                  <div className="space-y-2">
                     <label className="text-[10px] font-black text-slate-500 uppercase ml-4">Matriz de Memória (Lore & Personalidade)</label>
                     <textarea name="personality" placeholder="Como ele age? Qual seu passado? O Super-Cérebro usará isso para simular a consciência dele..." className="w-full input-dark rounded-[32px] p-6 text-xs min-h-[140px]" required />
                  </div>

                  <input name="greeting" placeholder="Primeira frase dele no chat..." className="w-full input-dark rounded-xl p-4 text-xs" required />

                  <div className="flex gap-4 pt-4">
                    <button type="button" onClick={() => setActiveModal(null)} className="flex-1 py-5 glass rounded-2xl font-black text-[10px] uppercase">Cancelar</button>
                    <button type="submit" className="flex-[2] py-5 btn-primary rounded-2xl font-black text-[10px] uppercase shadow-2xl">Manifestar IA</button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {activeModal === 'intro' && selectedChar && (
            <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setActiveModal(null)} className="absolute inset-0 bg-black/85 backdrop-blur-md" />
              <motion.div initial={{ opacity: 0, scale: 0.9, y: 30 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="glass-card rounded-[40px] w-full max-w-sm overflow-hidden relative z-10 border-white/10 shadow-2xl">
                <div className="h-44 bg-cover bg-center relative" style={{ backgroundImage: `url(${selectedChar.background || DEFAULT_BG[selectedChar.theme] || DEFAULT_BG.fantasy})` }}>
                   <div className="absolute inset-0 bg-gradient-to-t from-[#020205] to-transparent" />
                   <img src={selectedChar.avatar} className="absolute -bottom-10 left-8 w-24 h-24 rounded-3xl border-4 border-[#020205] object-cover shadow-2xl" />
                </div>
                <div className="pt-14 px-8 pb-10">
                   <h3 className="text-2xl font-black text-white">{selectedChar.name}</h3>
                   <p className="text-purple-400 text-[9px] font-black uppercase tracking-[0.2em] mt-2">{selectedChar.franchise}</p>
                   <p className="mt-6 text-[12px] text-slate-400 italic line-clamp-4 leading-relaxed">"{selectedChar.traits}"</p>
                   <div className="flex gap-3 mt-10">
                     <button onClick={() => setActiveModal(null)} className="flex-1 py-4 glass rounded-2xl font-black text-[10px] uppercase">Voltar</button>
                     <button onClick={() => startPrivateChat(selectedChar)} className="flex-[2] py-4 btn-primary rounded-2xl font-black text-[10px] uppercase shadow-2xl">MANIFESTAR</button>
                   </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default App;
