// WriteMutex and WriteMutexMap live in @bitclaw/mutex, which runs on any
// runtime. Re-exported so `@bitclaw/sqlite/write-mutex` keeps working.
export { WriteMutex, WriteMutexMap } from '@bitclaw/mutex';
