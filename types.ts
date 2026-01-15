
export type CharacterCategory = 'fantasy' | 'anime' | 'romance' | 'adventure' | 'horror' | 'scifi' | 'all';
export type ThemeType = 'fantasy' | 'scifi' | 'horror' | 'slice' | 'action' | 'romance';

export interface User {
  email: string;
  name: string;
  initial: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  type?: 'text' | 'image';
  timestamp: number;
}

export interface Character {
  id: string;
  authorId: string;
  name: string;
  franchise: string; // Ex: Ben 10, Dragon Ball
  gender: string;
  desc: string;
  traits: string;
  avatar: string;
  category: CharacterCategory;
  theme: ThemeType;
  personality: string;
  greeting: string;
  emoji?: string;
  isPublic: boolean;
  background?: string;
  voiceType?: 'male' | 'female';
  voiceFilter?: string; // Ex: Heróico, Sussurrado, Rouco
}

export interface ChatHistoryEntry {
  charId: string;
  lastMsg: string;
  timestamp: number;
}
