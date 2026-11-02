#!/usr/bin/env python3
"""LOCAL ONLY. Sends a whole SQL file as ONE simple-protocol Query message (libpq PQexec), the way the Supabase Management API
query endpoint (pg-meta) runs a request body: explicit begin/commit blocks are separate transactions, the first error stops the
rest of the string and earlier commits stay. psql -c does the same but hits the argv size limit on large files.
usage: api_exec.py <db> <file.sql>   (PGHOST/PGPORT/PGUSER from the environment; exit 1 with the server error on failure)"""
import ctypes, ctypes.util, os, sys
lib = ctypes.CDLL(os.environ.get('LIBPQ') or ctypes.util.find_library('pq') or 'libpq.so.5')
lib.PQconnectdb.restype = ctypes.c_void_p; lib.PQconnectdb.argtypes = [ctypes.c_char_p]
lib.PQstatus.argtypes = [ctypes.c_void_p]
lib.PQexec.restype = ctypes.c_void_p; lib.PQexec.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
lib.PQresultStatus.argtypes = [ctypes.c_void_p]
lib.PQresultErrorMessage.restype = ctypes.c_char_p; lib.PQresultErrorMessage.argtypes = [ctypes.c_void_p]
lib.PQerrorMessage.restype = ctypes.c_char_p; lib.PQerrorMessage.argtypes = [ctypes.c_void_p]
lib.PQtransactionStatus.argtypes = [ctypes.c_void_p]
lib.PQfinish.argtypes = [ctypes.c_void_p]; lib.PQclear.argtypes = [ctypes.c_void_p]
db, path = sys.argv[1], sys.argv[2]
conn = lib.PQconnectdb(f"dbname={db} options='-c client_min_messages=warning'".encode())
if lib.PQstatus(conn) != 0: sys.exit('connect failed: ' + lib.PQerrorMessage(conn).decode())
res = lib.PQexec(conn, open(path, 'rb').read())
st = lib.PQresultStatus(res)            # 1 COMMAND_OK, 2 TUPLES_OK, 7 FATAL_ERROR
err = lib.PQresultErrorMessage(res).decode() if res else lib.PQerrorMessage(conn).decode()
tx = lib.PQtransactionStatus(conn)      # 0 idle, 3 in failed transaction block
lib.PQclear(res); lib.PQfinish(conn)
if st not in (1, 2):
    sys.stderr.write(f'{os.path.basename(path)}: ERROR (session left {"in a failed transaction block" if tx == 3 else "idle"}): {err}')
    sys.exit(1)
