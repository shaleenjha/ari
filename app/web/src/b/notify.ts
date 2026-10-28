// The toast channel: any screen can say what just happened, with an optional Undo (handled by App).
import { createContext, useContext } from 'react';

export const NoteContext = createContext<(text: string, undo?: boolean) => void>(() => undefined);
export const useNotify = () => useContext(NoteContext);
