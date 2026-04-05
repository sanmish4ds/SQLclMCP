#!/usr/bin/env python3
"""
TPC-H Data Setup for Oracle Autonomous DB (prishivdb1).

Exact replica of ~/oracle26ai-eval/data_setup.py but self-contained
(no src.core imports) and pre-configured for prishivdb1.

Loads:
  REGION      5 rows
  NATION      25 rows
  SUPPLIER    10,000 rows
  PART        20,000 rows
  PARTSUPP    80,000 rows
  CUSTOMER    150,000 rows
  ORDERS      700,000 rows
  LINEITEM    4,000,000 rows

Run:
    cd /Users/sanjaymishra/SQLclMCP
    python3 experiments/data_setup.py
"""

import sys, os, random, string
from datetime import datetime, timedelta
from dotenv import load_dotenv
load_dotenv()

try:
    import oracledb
except ImportError:
    sys.exit("oracledb not installed. Run: pip install -r experiments/eval-requirements.txt")

# ── Connection config (from environment) ─────────────────────────────────────-
#
# Reads the same style of variables as the MCP server, plus wallet settings:
#   DB_USER, DB_PASSWORD, DB_DSN
#   ORACLE_WALLET_PATH, ORACLE_WALLET_PWD

ORACLE_USER        = os.getenv("DB_USER", "admin")
ORACLE_PASSWORD    = os.getenv("DB_PASSWORD")
ORACLE_DSN         = os.getenv("DB_DSN", "prishivdb1_high")
ORACLE_WALLET_PATH = os.getenv("ORACLE_WALLET_PATH", "/Users/sanjaymishra/Downloads/Wallet_prishivdb_new")
ORACLE_WALLET_PWD  = os.getenv("ORACLE_WALLET_PWD")

# ── Data helpers ──────────────────────────────────────────────────────────────

r  = random.Random(42)
rc = lambda: ''.join(r.choices(string.ascii_letters + string.digits, k=15))

# ── DDL ───────────────────────────────────────────────────────────────────────

CREATE_TABLES_SQL = [
    "CREATE TABLE REGION (R_REGIONKEY NUMBER(38,0) NOT NULL PRIMARY KEY, R_NAME CHAR(25), R_COMMENT VARCHAR2(152))",
    "CREATE TABLE NATION (N_NATIONKEY NUMBER(38,0) NOT NULL PRIMARY KEY, N_NAME CHAR(25), N_REGIONKEY NUMBER(38,0), N_COMMENT VARCHAR2(152))",
    "CREATE TABLE SUPPLIER (S_SUPPKEY NUMBER(38,0) NOT NULL PRIMARY KEY, S_NAME CHAR(25), S_ADDRESS VARCHAR2(40), S_NATIONKEY NUMBER(38,0), S_PHONE CHAR(15), S_ACCTBAL NUMBER(15,2), S_COMMENT VARCHAR2(101))",
    "CREATE TABLE PART (P_PARTKEY NUMBER(38,0) NOT NULL PRIMARY KEY, P_NAME VARCHAR2(55), P_MFGR CHAR(25), P_BRAND CHAR(10), P_TYPE VARCHAR2(25), P_SIZE NUMBER(38,0), P_CONTAINER CHAR(10), P_RETAILPRICE NUMBER(15,2), P_COMMENT VARCHAR2(23))",
    "CREATE TABLE PARTSUPP (PS_PARTKEY NUMBER(38,0), PS_SUPPKEY NUMBER(38,0), PS_AVAILQTY NUMBER(38,0), PS_SUPPLYCOST NUMBER(15,2), PS_COMMENT VARCHAR2(199), PRIMARY KEY (PS_PARTKEY, PS_SUPPKEY))",
    "CREATE TABLE CUSTOMER (C_CUSTKEY NUMBER(38,0) NOT NULL PRIMARY KEY, C_NAME VARCHAR2(25), C_ADDRESS VARCHAR2(40), C_NATIONKEY NUMBER(38,0), C_PHONE CHAR(15), C_ACCTBAL NUMBER(15,2), C_MKTSEGMENT CHAR(10), C_COMMENT VARCHAR2(117))",
    "CREATE TABLE ORDERS (O_ORDERKEY NUMBER(38,0) NOT NULL PRIMARY KEY, O_CUSTKEY NUMBER(38,0), O_ORDERSTATUS CHAR(1), O_TOTALPRICE NUMBER(15,2), O_ORDERDATE DATE, O_ORDERPRIORITY CHAR(15), O_CLERK CHAR(15), O_SHIPPRIORITY NUMBER(38,0), O_COMMENT VARCHAR2(79))",
    "CREATE TABLE LINEITEM (L_ORDERKEY NUMBER(38,0), L_PARTKEY NUMBER(38,0), L_SUPPKEY NUMBER(38,0), L_LINENUMBER NUMBER(38,0), L_QUANTITY NUMBER(15,2), L_EXTENDEDPRICE NUMBER(15,2), L_DISCOUNT NUMBER(15,2), L_TAX NUMBER(15,2), L_RETURNFLAG CHAR(1), L_LINESTATUS CHAR(1), L_SHIPDATE DATE, L_COMMITDATE DATE, L_RECEIPTDATE DATE, L_SHIPMODE CHAR(10), L_SHIPINSTRUCT CHAR(25), L_COMMENT VARCHAR2(44))",
]

# ── Connection ────────────────────────────────────────────────────────────────

def get_connection():
    if not ORACLE_PASSWORD:
        sys.exit("DB_PASSWORD not set. Add it to .env before running data_setup.py.")
    wallet = os.path.expanduser(ORACLE_WALLET_PATH)
    if not os.path.isdir(wallet):
        sys.exit(f"Wallet folder not found: {wallet} (set ORACLE_WALLET_PATH in .env)")
    if not ORACLE_WALLET_PWD:
        sys.exit("ORACLE_WALLET_PWD not set. Add it to .env for your Autonomous DB wallet.")
    conn = oracledb.connect(
        user=ORACLE_USER,
        password=ORACLE_PASSWORD,
        dsn=ORACLE_DSN,
        config_dir=wallet,
        wallet_location=wallet,
        wallet_password=ORACLE_WALLET_PWD,
    )
    return conn

# ── Schema ────────────────────────────────────────────────────────────────────

def drop_tables(cursor):
    for tbl in ['LINEITEM', 'ORDERS', 'CUSTOMER', 'PARTSUPP', 'PART', 'SUPPLIER', 'NATION', 'REGION']:
        try:
            cursor.execute(f"DROP TABLE {tbl} CASCADE CONSTRAINTS PURGE")
            print(f"  Dropped  {tbl}")
        except Exception:
            pass

def create_tables(cursor):
    for ddl in CREATE_TABLES_SQL:
        tbl = ddl.split()[2]
        cursor.execute(ddl)
        print(f"  Created  {tbl}")

# ── Bulk insert ───────────────────────────────────────────────────────────────

def bulk_insert(cursor, conn, table, cols, placeholders, data, chunk=1000):
    try:
        cursor.execute(f"ALTER TABLE {table} NOLOGGING")
    except Exception:
        pass
    sql = f"INSERT /*+ APPEND PARALLEL(8) */ INTO {table} ({cols}) VALUES ({placeholders})"
    for i in range(0, len(data), chunk):
        cursor.executemany(sql, data[i:i+chunk])
        if i % 100000 == 0 and i > 0:
            conn.commit()
            print(f"    {table}: {i:,} rows committed…")
    conn.commit()
    try:
        cursor.execute(f"ALTER TABLE {table} LOGGING")
    except Exception:
        pass
    print(f"  [OK] {table}: {len(data):,} rows")

# ── Data generation (same scale as oracle26ai-eval) ───────────────────────────

def insert_data(cursor, conn):
    base_date = datetime.now() - timedelta(days=365)

    # REGION (5)
    bulk_insert(cursor, conn, "REGION",
        "R_REGIONKEY, R_NAME, R_COMMENT", ":1, :2, :3",
        [(i, f'Region#{i}', rc()) for i in range(5)])

    # NATION (25)
    bulk_insert(cursor, conn, "NATION",
        "N_NATIONKEY, N_NAME, N_REGIONKEY, N_COMMENT", ":1, :2, :3, :4",
        [(i, f'Nation#{i}', i % 5, rc()) for i in range(25)])

    # SUPPLIER (10K)
    bulk_insert(cursor, conn, "SUPPLIER",
        "S_SUPPKEY, S_NAME, S_ADDRESS, S_NATIONKEY, S_PHONE, S_ACCTBAL, S_COMMENT", ":1,:2,:3,:4,:5,:6,:7",
        [(i, f'Sup#{i}', f'Addr{i}', i%25, f'Ph{i}', 5000+i, rc()) for i in range(1, 10001)])

    # PART (20K)
    bulk_insert(cursor, conn, "PART",
        "P_PARTKEY, P_NAME, P_MFGR, P_BRAND, P_TYPE, P_SIZE, P_CONTAINER, P_RETAILPRICE, P_COMMENT", ":1,:2,:3,:4,:5,:6,:7,:8,:9",
        [(i, f'Part#{i}', 'Mfg1', 'B1', 'Type1', 10, 'Bag', 900+(i%500), rc()) for i in range(1, 20001)])

    # PARTSUPP (80K)
    bulk_insert(cursor, conn, "PARTSUPP",
        "PS_PARTKEY, PS_SUPPKEY, PS_AVAILQTY, PS_SUPPLYCOST, PS_COMMENT", ":1,:2,:3,:4,:5",
        [(i, (i%10000)+1, 100+(i%8000), 50+(i%100), rc()) for i in range(1, 80001)])

    # CUSTOMER (150K)
    bulk_insert(cursor, conn, "CUSTOMER",
        "C_CUSTKEY, C_NAME, C_ADDRESS, C_NATIONKEY, C_PHONE, C_ACCTBAL, C_MKTSEGMENT, C_COMMENT", ":1,:2,:3,:4,:5,:6,:7,:8",
        [(i, f'Cust#{i}', f'Addr{i}', i%25, f'Ph{i}', 1000+(i%100000), 'Seg', rc()) for i in range(1, 150001)])

    # ORDERS (700K)
    print("  Generating ORDERS data (700K)…")
    bulk_insert(cursor, conn, "ORDERS",
        "O_ORDERKEY, O_CUSTKEY, O_ORDERSTATUS, O_TOTALPRICE, O_ORDERDATE, O_ORDERPRIORITY, O_CLERK, O_SHIPPRIORITY, O_COMMENT", ":1,:2,:3,:4,:5,:6,:7,:8,:9",
        [(i, (i%150000)+1, 'O', 1500+(i%100000), base_date+timedelta(days=i%365),
          'P1', 'C1', 0, rc()) for i in range(1, 700001)],
        chunk=5000)

    # LINEITEM (4M)
    print("  Generating LINEITEM data (4M) — this takes a few minutes…")
    bulk_insert(cursor, conn, "LINEITEM",
        "L_ORDERKEY, L_LINENUMBER, L_SHIPDATE, L_PARTKEY, L_SUPPKEY, L_QUANTITY, L_EXTENDEDPRICE, L_DISCOUNT, L_TAX, L_RETURNFLAG, L_LINESTATUS, L_COMMITDATE, L_RECEIPTDATE, L_SHIPMODE, L_SHIPINSTRUCT, L_COMMENT",
        ":1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14,:15,:16",
        [(i, ((i-1)//6)+1, base_date+timedelta(days=i%365),
          (i%20000)+1, (i%10000)+1, 10.0, 200+(i%100000), 0.05, 0.02,
          'N', 'O',
          base_date+timedelta(days=(i%365)+30),
          base_date+timedelta(days=(i%365)+45),
          'Truck', 'Deliver', rc()) for i in range(1, 4000001)],
        chunk=5000)

# ── Verify ────────────────────────────────────────────────────────────────────

def verify(cursor):
    print("\nRow counts:")
    for tbl in ['REGION', 'NATION', 'SUPPLIER', 'PART', 'PARTSUPP', 'CUSTOMER', 'ORDERS', 'LINEITEM']:
        try:
            cursor.execute(f"SELECT COUNT(*) FROM {tbl}")
            print(f"  {tbl:<15} {cursor.fetchone()[0]:>10,} rows")
        except Exception as e:
            print(f"  {tbl:<15} ERROR: {e}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n=== TPC-H Data Setup → prishivdb1 ===")
    print(f"  DSN    : {ORACLE_DSN}")
    print(f"  Wallet : {ORACLE_WALLET_PATH}")
    print(f"  User   : {ORACLE_USER}\n")

    conn = get_connection()
    print(f"Connected OK.\n")
    cur = conn.cursor()

    print("[1/4] Dropping existing TPC-H tables…")
    drop_tables(cur)

    print("\n[2/4] Creating TPC-H tables…")
    create_tables(cur)

    print("\n[3/4] Loading data…")
    insert_data(cur, conn)

    print("\n[4/4] Verifying…")
    verify(cur)

    cur.close()
    conn.close()
    print("\n[SUCCESS] prishivdb1 is ready for MCP queries.\n")

if __name__ == "__main__":
    main()
