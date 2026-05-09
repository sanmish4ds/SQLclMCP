#!/usr/bin/env python3
"""Generate 500 fresh TPC-H-style Oracle SQL questions (different from sql-practice-rules.json)."""
import json, random, pathlib

random.seed(42)

OUT = pathlib.Path(__file__).parent / "new-practice-questions.json"

# ── Building blocks ────────────────────────────────────────────────────────────
REGIONS   = ["AFRICA", "AMERICA", "ASIA", "EUROPE", "MIDDLE EAST"]
MKTSEG    = ["AUTOMOBILE", "BUILDING", "FURNITURE", "MACHINERY", "HOUSEHOLD"]
SHIP_MODE = ["AIR", "FOB", "MAIL", "RAIL", "REG AIR", "SHIP", "TRUCK"]
NATIONS   = ["ALGERIA", "ARGENTINA", "BRAZIL", "CANADA", "EGYPT", "ETHIOPIA",
             "FRANCE", "GERMANY", "INDIA", "INDONESIA", "IRAN", "IRAQ",
             "JAPAN", "JORDAN", "KENYA", "MOROCCO", "MOZAMBIQUE", "PERU",
             "CHINA", "ROMANIA", "SAUDI ARABIA", "VIETNAM", "RUSSIA",
             "UNITED KINGDOM", "UNITED STATES"]
PART_TYPES = ["BRASS", "COPPER", "NICKEL", "STEEL", "TIN"]
PART_SIZES = [i for i in range(1, 51)]
P_TYPES    = ["ECONOMY", "PROMO", "SMALL", "MEDIUM", "LARGE", "STANDARD"]
YEARS      = [1993, 1994, 1995, 1996, 1997, 1998]
QUARTERS   = [1, 2, 3, 4]

questions = []
qid = 1

def add(cat, complexity, question, sql):
    global qid
    questions.append({
        "id": qid,
        "category": cat,
        "complexity": complexity,
        "question": question,
        "expected_sql": sql.strip(),
        "description": "Auto-generated SQL test"
    })
    qid += 1

# ── SIMPLE (100 questions) ─────────────────────────────────────────────────────

# Nation count by region (5)
for r in REGIONS:
    add("simple_nation_region", "simple",
        f"How many nations are in the {r.title()} region?",
        f"SELECT COUNT(*) FROM NATION N JOIN REGION R ON N.N_REGIONKEY = R.R_REGIONKEY WHERE R.R_NAME = '{r}'")

# Supplier count (5)
for n in random.sample(NATIONS, 5):
    add("simple_supplier_count", "simple",
        f"How many suppliers are from {n.title()}?",
        f"SELECT COUNT(*) FROM SUPPLIER S JOIN NATION N ON S.S_NATIONKEY = N.N_NATIONKEY WHERE N.N_NAME = '{n}'")

# Part count by type (5)
for pt in PART_TYPES:
    add("simple_part_type", "simple",
        f"How many parts contain '{pt}' in their type?",
        f"SELECT COUNT(*) FROM PART WHERE P_TYPE LIKE '%{pt}%'")

# Customer count by market segment (5)
for ms in MKTSEG:
    add("simple_customer_segment", "simple",
        f"How many customers are in the {ms.lower()} market segment?",
        f"SELECT COUNT(*) FROM CUSTOMER WHERE C_MKTSEGMENT = '{ms}'")

# Min/max part size (2)
add("simple_part_size", "simple", "What is the smallest part size available?",
    "SELECT MIN(P_SIZE) FROM PART")
add("simple_part_size", "simple", "What is the largest part size available?",
    "SELECT MAX(P_SIZE) FROM PART")

# Total orders (1)
add("simple_orders_count", "simple", "How many total orders are in the orders table?",
    "SELECT COUNT(*) FROM ORDERS")

# Distinct ship modes (1)
add("simple_distinct", "simple", "How many distinct ship modes are used in line items?",
    "SELECT COUNT(DISTINCT L_SHIPMODE) FROM LINEITEM")

# Average account balance per region (5)
for r in REGIONS:
    add("simple_avg_balance", "simple",
        f"What is the average account balance of customers in the {r.title()} region?",
        f"SELECT AVG(C.C_ACCTBAL) FROM CUSTOMER C JOIN NATION N ON C.C_NATIONKEY = N.N_NATIONKEY JOIN REGION R ON N.N_REGIONKEY = R.R_REGIONKEY WHERE R.R_NAME = '{r}'")

# Total revenue per ship mode (7 modes, pick 7)
for sm in SHIP_MODE:
    add("simple_revenue_shipmode", "simple",
        f"What is the total extended price for line items shipped by {sm.lower()}?",
        f"SELECT SUM(L_EXTENDEDPRICE) FROM LINEITEM WHERE L_SHIPMODE = '{sm}'")

# Count orders per order status (3 statuses)
for st, label in [("O", "open"), ("F", "fulfilled"), ("P", "pending")]:
    add("simple_order_status", "simple",
        f"How many orders have status '{label}'?",
        f"SELECT COUNT(*) FROM ORDERS WHERE O_ORDERSTATUS = '{st}'")

# Parts with retail price above threshold (5)
for thresh in [500, 1000, 1500, 2000, 2500]:
    add("simple_retail_price", "simple",
        f"How many parts have a retail price greater than {thresh}?",
        f"SELECT COUNT(*) FROM PART WHERE P_RETAILPRICE > {thresh}")

# Supplier total supply cost by nation (5 nations)
for n in random.sample(NATIONS, 5):
    add("simple_supply_cost", "simple",
        f"What is the total available supply cost for suppliers from {n.title()}?",
        f"SELECT SUM(PS.PS_SUPPLYCOST) FROM PARTSUPP PS JOIN SUPPLIER S ON PS.PS_SUPPKEY = S.S_SUPPKEY JOIN NATION N ON S.S_NATIONKEY = N.N_NATIONKEY WHERE N.N_NAME = '{n}'")

# Count parts of exact size (5)
for sz in random.sample(PART_SIZES, 5):
    add("simple_part_size_exact", "simple",
        f"How many parts have size exactly {sz}?",
        f"SELECT COUNT(*) FROM PART WHERE P_SIZE = {sz}")

# Orders placed in a specific year (6 years)
for yr in YEARS:
    add("simple_orders_year", "simple",
        f"How many orders were placed in {yr}?",
        f"SELECT COUNT(*) FROM ORDERS WHERE EXTRACT(YEAR FROM O_ORDERDATE) = {yr}")

# Suppliers with negative account balance (1)
add("simple_negative_balance", "simple", "How many suppliers have a negative account balance?",
    "SELECT COUNT(*) FROM SUPPLIER WHERE S_ACCTBAL < 0")

# Customers with no orders (1)
add("simple_no_orders", "simple", "How many customers have never placed an order?",
    "SELECT COUNT(*) FROM CUSTOMER C WHERE NOT EXISTS (SELECT 1 FROM ORDERS O WHERE O.O_CUSTKEY = C.C_CUSTKEY)")

# Top retail price (1)
add("simple_top_retail", "simple", "What is the maximum retail price of any part?",
    "SELECT MAX(P_RETAILPRICE) FROM PART")

# Count line items with discount (1)
add("simple_discount", "simple", "How many line items have a discount greater than 0?",
    "SELECT COUNT(*) FROM LINEITEM WHERE L_DISCOUNT > 0")

# Average line item quantity (1)
add("simple_avg_qty", "simple", "What is the average quantity of line items?",
    "SELECT AVG(L_QUANTITY) FROM LINEITEM")

# Fill to 100 simple
while len([q for q in questions if q['complexity'] == 'simple']) < 100:
    idx = len([q for q in questions if q['complexity'] == 'simple'])
    yr = random.choice(YEARS)
    n = random.choice(NATIONS)
    add("simple_filler", "simple",
        f"How many line items were shipped in {yr} for orders from customers in {n.title()}?",
        f"SELECT COUNT(*) FROM LINEITEM L JOIN ORDERS O ON L.L_ORDERKEY = O.O_ORDERKEY JOIN CUSTOMER C ON O.O_CUSTKEY = C.C_CUSTKEY JOIN NATION N ON C.C_NATIONKEY = N.N_NATIONKEY WHERE EXTRACT(YEAR FROM L.L_SHIPDATE) = {yr} AND N.N_NAME = '{n}'")

# ── MEDIUM (100 questions) ─────────────────────────────────────────────────────

# Revenue by nation and year (10)
for n in random.sample(NATIONS, 5):
    for yr in random.sample(YEARS, 2):
        add("medium_revenue_nation_year", "medium",
            f"What is the total revenue (extended price minus discount) for orders from {n.title()} in {yr}?",
            f"SELECT SUM(L.L_EXTENDEDPRICE * (1 - L.L_DISCOUNT)) FROM LINEITEM L JOIN ORDERS O ON L.L_ORDERKEY = O.O_ORDERKEY JOIN CUSTOMER C ON O.O_CUSTKEY = C.C_CUSTKEY JOIN NATION N ON C.C_NATIONKEY = N.N_NATIONKEY WHERE N.N_NAME = '{n}' AND EXTRACT(YEAR FROM O.O_ORDERDATE) = {yr}")

# Average order total price by market segment (5)
for ms in MKTSEG:
    add("medium_avg_order_segment", "medium",
        f"What is the average total price of orders placed by {ms.lower()} segment customers?",
        f"SELECT AVG(O.O_TOTALPRICE) FROM ORDERS O JOIN CUSTOMER C ON O.O_CUSTKEY = C.C_CUSTKEY WHERE C.C_MKTSEGMENT = '{ms}'")

# Top 5 nations by number of customers (1)
add("medium_top_nations_customers", "medium",
    "Which 5 nations have the most customers? Show nation name and count.",
    "SELECT N.N_NAME, COUNT(*) AS CNT FROM CUSTOMER C JOIN NATION N ON C.C_NATIONKEY = N.N_NATIONKEY GROUP BY N.N_NAME ORDER BY CNT DESC FETCH FIRST 5 ROWS ONLY")

# Parts supplied by more than N suppliers (5)
for n in [3, 5, 8, 10, 15]:
    add("medium_parts_multi_supplier", "medium",
        f"How many parts are supplied by more than {n} suppliers?",
        f"SELECT COUNT(*) FROM (SELECT PS_PARTKEY FROM PARTSUPP GROUP BY PS_PARTKEY HAVING COUNT(*) > {n})")

# Revenue per quarter for a given year (4)
for yr in random.sample(YEARS, 4):
    add("medium_revenue_quarter", "medium",
        f"What is the total revenue by quarter in {yr}?",
        f"SELECT EXTRACT(QUARTER FROM O.O_ORDERDATE) AS QTR, SUM(L.L_EXTENDEDPRICE * (1 - L.L_DISCOUNT)) AS REVENUE FROM ORDERS O JOIN LINEITEM L ON O.O_ORDERKEY = L.L_ORDERKEY WHERE EXTRACT(YEAR FROM O.O_ORDERDATE) = {yr} GROUP BY EXTRACT(QUARTER FROM O.O_ORDERDATE) ORDER BY QTR")

# Average supply cost by region (5)
for r in REGIONS:
    add("medium_supply_cost_region", "medium",
        f"What is the average supply cost for parts supplied to customers in the {r.title()} region?",
        f"SELECT AVG(PS.PS_SUPPLYCOST) FROM PARTSUPP PS JOIN SUPPLIER S ON PS.PS_SUPPKEY = S.S_SUPPKEY JOIN NATION N ON S.S_NATIONKEY = N.N_NATIONKEY JOIN REGION R ON N.N_REGIONKEY = R.R_REGIONKEY WHERE R.R_NAME = '{r}'")

# Orders with more than N line items (5)
for n in [3, 4, 5, 6, 7]:
    add("medium_orders_many_lines", "medium",
        f"How many orders have more than {n} line items?",
        f"SELECT COUNT(*) FROM (SELECT L_ORDERKEY FROM LINEITEM GROUP BY L_ORDERKEY HAVING COUNT(*) > {n})")

# Total discount given per ship mode (7)
for sm in SHIP_MODE:
    add("medium_discount_by_mode", "medium",
        f"What is the total discount amount given for {sm.lower()} shipments?",
        f"SELECT SUM(L_EXTENDEDPRICE * L_DISCOUNT) FROM LINEITEM WHERE L_SHIPMODE = '{sm}'")

# Customers with order total above threshold (5)
for thresh in [50000, 100000, 200000, 300000, 500000]:
    add("medium_high_value_customers", "medium",
        f"How many customers have placed at least one order with a total price exceeding {thresh}?",
        f"SELECT COUNT(DISTINCT O.O_CUSTKEY) FROM ORDERS O WHERE O.O_TOTALPRICE > {thresh}")

# Nations with avg customer balance above threshold (5 different)
for thresh in [2000, 3000, 4000, 5000, 6000]:
    add("medium_nation_balance", "medium",
        f"Which nations have an average customer account balance above {thresh}?",
        f"SELECT N.N_NAME, AVG(C.C_ACCTBAL) AS AVG_BAL FROM CUSTOMER C JOIN NATION N ON C.C_NATIONKEY = N.N_NATIONKEY GROUP BY N.N_NAME HAVING AVG(C.C_ACCTBAL) > {thresh} ORDER BY AVG_BAL DESC")

# Parts never ordered (1)
add("medium_never_ordered", "medium", "How many parts have never appeared in any line item?",
    "SELECT COUNT(*) FROM PART P WHERE NOT EXISTS (SELECT 1 FROM LINEITEM L WHERE L.L_PARTKEY = P.P_PARTKEY)")

# Revenue growth year-over-year (1)
add("medium_revenue_growth", "medium",
    "Show total revenue per year for all years, ordered by year.",
    "SELECT EXTRACT(YEAR FROM O.O_ORDERDATE) AS YR, SUM(L.L_EXTENDEDPRICE * (1 - L.L_DISCOUNT)) AS REVENUE FROM ORDERS O JOIN LINEITEM L ON O.O_ORDERKEY = L.L_ORDERKEY GROUP BY EXTRACT(YEAR FROM O.O_ORDERDATE) ORDER BY YR")

# Fill to 100 medium
while len([q for q in questions if q['complexity'] == 'medium']) < 100:
    yr = random.choice(YEARS)
    sm = random.choice(SHIP_MODE)
    add("medium_filler", "medium",
        f"What is the total quantity shipped via {sm.lower()} for orders placed in {yr}?",
        f"SELECT SUM(L.L_QUANTITY) FROM LINEITEM L JOIN ORDERS O ON L.L_ORDERKEY = O.O_ORDERKEY WHERE L.L_SHIPMODE = '{sm}' AND EXTRACT(YEAR FROM O.O_ORDERDATE) = {yr}")

# ── COMPLEX (300 questions) ────────────────────────────────────────────────────

# Nested subquery: customers whose total spend > avg (5)
for ms in MKTSEG:
    add("complex_above_avg_spend", "complex",
        f"List {ms.lower()} customers whose total spend exceeds the average order total price across all customers.",
        f"SELECT C.C_NAME, SUM(O.O_TOTALPRICE) AS TOTAL_SPEND FROM CUSTOMER C JOIN ORDERS O ON C.C_CUSTKEY = O.O_CUSTKEY WHERE C.C_MKTSEGMENT = '{ms}' GROUP BY C.C_NAME HAVING SUM(O.O_TOTALPRICE) > (SELECT AVG(O2.O_TOTALPRICE) FROM ORDERS O2) ORDER BY TOTAL_SPEND DESC")

# CTE: top supplier per nation (5 nations)
for n in random.sample(NATIONS, 5):
    add("complex_cte_top_supplier", "complex",
        f"Using a CTE, find the supplier from {n.title()} with the highest account balance.",
        f"WITH RANKED AS (SELECT S.S_NAME, S.S_ACCTBAL, RANK() OVER (ORDER BY S.S_ACCTBAL DESC) RNK FROM SUPPLIER S JOIN NATION N ON S.S_NATIONKEY = N.N_NATIONKEY WHERE N.N_NAME = '{n}') SELECT S_NAME, S_ACCTBAL FROM RANKED WHERE RNK = 1")

# Window function: rank customers by spend within segment (5)
for ms in MKTSEG:
    add("complex_window_rank", "complex",
        f"Rank customers in the {ms.lower()} segment by their total order amount, showing top 10.",
        f"SELECT C.C_NAME, SUM(O.O_TOTALPRICE) AS TOTAL, RANK() OVER (ORDER BY SUM(O.O_TOTALPRICE) DESC) RNK FROM CUSTOMER C JOIN ORDERS O ON C.C_CUSTKEY = O.O_CUSTKEY WHERE C.C_MKTSEGMENT = '{ms}' GROUP BY C.C_NAME FETCH FIRST 10 ROWS ONLY")

# Multi-join: parts supplied cheapest from which nation (5)
for pt in PART_TYPES:
    add("complex_cheapest_source", "complex",
        f"For each {pt.lower()} part, which nation provides the cheapest supply? Show part key, nation, and min supply cost.",
        f"SELECT P.P_PARTKEY, N.N_NAME, MIN(PS.PS_SUPPLYCOST) AS MIN_COST FROM PART P JOIN PARTSUPP PS ON P.P_PARTKEY = PS.PS_PARTKEY JOIN SUPPLIER S ON PS.PS_SUPPKEY = S.S_SUPPKEY JOIN NATION N ON S.S_NATIONKEY = N.N_NATIONKEY WHERE P.P_TYPE LIKE '%{pt}%' GROUP BY P.P_PARTKEY, N.N_NAME ORDER BY P.P_PARTKEY, MIN_COST")

# CTE rolling revenue (6 years)
for yr in YEARS:
    add("complex_cte_rolling", "complex",
        f"Using a CTE, calculate the cumulative revenue month by month for {yr}.",
        f"WITH MONTHLY AS (SELECT EXTRACT(MONTH FROM O.O_ORDERDATE) AS MON, SUM(L.L_EXTENDEDPRICE * (1 - L.L_DISCOUNT)) AS REV FROM ORDERS O JOIN LINEITEM L ON O.O_ORDERKEY = L.L_ORDERKEY WHERE EXTRACT(YEAR FROM O.O_ORDERDATE) = {yr} GROUP BY EXTRACT(MONTH FROM O.O_ORDERDATE)) SELECT MON, REV, SUM(REV) OVER (ORDER BY MON) AS CUMULATIVE FROM MONTHLY ORDER BY MON")

# Shipping delay analysis by mode (7)
for sm in SHIP_MODE:
    add("complex_shipping_delay", "complex",
        f"What is the average, min, and max shipping delay (in days from commit to ship date) for {sm.lower()} shipments?",
        f"SELECT AVG(L_SHIPDATE - L_COMMITDATE) AS AVG_DELAY, MIN(L_SHIPDATE - L_COMMITDATE) AS MIN_DELAY, MAX(L_SHIPDATE - L_COMMITDATE) AS MAX_DELAY FROM LINEITEM WHERE L_SHIPMODE = '{sm}'")

# Correlated subquery: parts with supply cost above avg for their type (5)
for pt in PART_TYPES:
    add("complex_correlated_supply", "complex",
        f"Find all {pt.lower()} parts where the minimum supply cost is above the average supply cost for all {pt.lower()} parts.",
        f"SELECT P.P_PARTKEY, P.P_NAME, MIN(PS.PS_SUPPLYCOST) AS MIN_COST FROM PART P JOIN PARTSUPP PS ON P.P_PARTKEY = PS.PS_PARTKEY WHERE P.P_TYPE LIKE '%{pt}%' GROUP BY P.P_PARTKEY, P.P_NAME HAVING MIN(PS.PS_SUPPLYCOST) > (SELECT AVG(PS2.PS_SUPPLYCOST) FROM PARTSUPP PS2 JOIN PART P2 ON PS2.PS_PARTKEY = P2.P_PARTKEY WHERE P2.P_TYPE LIKE '%{pt}%') ORDER BY MIN_COST DESC")

# Nation pair trade flow analysis (5)
for r in REGIONS:
    add("complex_trade_flow", "complex",
        f"For the {r.title()} region, show revenue by supplier nation and customer nation pair.",
        f"SELECT SN.N_NAME AS SUPPLIER_NATION, CN.N_NAME AS CUSTOMER_NATION, SUM(L.L_EXTENDEDPRICE * (1 - L.L_DISCOUNT)) AS REVENUE FROM LINEITEM L JOIN ORDERS O ON L.L_ORDERKEY = O.O_ORDERKEY JOIN CUSTOMER C ON O.O_CUSTKEY = C.C_CUSTKEY JOIN NATION CN ON C.C_NATIONKEY = CN.N_NATIONKEY JOIN SUPPLIER S ON L.L_SUPPKEY = S.S_SUPPKEY JOIN NATION SN ON S.S_NATIONKEY = SN.N_NATIONKEY JOIN REGION CR ON CN.N_REGIONKEY = CR.R_REGIONKEY WHERE CR.R_NAME = '{r}' GROUP BY SN.N_NAME, CN.N_NAME ORDER BY REVENUE DESC")

# Year-over-year growth rate by segment (5 segments)
for ms in MKTSEG:
    add("complex_yoy_growth", "complex",
        f"Calculate year-over-year revenue growth rate for the {ms.lower()} market segment.",
        f"WITH YEARLY AS (SELECT EXTRACT(YEAR FROM O.O_ORDERDATE) AS YR, SUM(L.L_EXTENDEDPRICE * (1 - L.L_DISCOUNT)) AS REV FROM ORDERS O JOIN LINEITEM L ON O.O_ORDERKEY = L.L_ORDERKEY JOIN CUSTOMER C ON O.O_CUSTKEY = C.C_CUSTKEY WHERE C.C_MKTSEGMENT = '{ms}' GROUP BY EXTRACT(YEAR FROM O.O_ORDERDATE)) SELECT YR, REV, LAG(REV) OVER (ORDER BY YR) AS PREV_REV, ROUND((REV - LAG(REV) OVER (ORDER BY YR)) / LAG(REV) OVER (ORDER BY YR) * 100, 2) AS GROWTH_PCT FROM YEARLY ORDER BY YR")

# Supplier market share within region (5)
for r in REGIONS:
    add("complex_supplier_share", "complex",
        f"For the {r.title()} region, what is each supplier nation's percentage share of total supply value?",
        f"WITH REGIONAL AS (SELECT N.N_NAME, SUM(PS.PS_SUPPLYCOST * PS.PS_AVAILQTY) AS SUPPLY_VAL FROM PARTSUPP PS JOIN SUPPLIER S ON PS.PS_SUPPKEY = S.S_SUPPKEY JOIN NATION N ON S.S_NATIONKEY = N.N_NATIONKEY JOIN REGION R ON N.N_REGIONKEY = R.R_REGIONKEY WHERE R.R_NAME = '{r}' GROUP BY N.N_NAME), TOTAL AS (SELECT SUM(SUPPLY_VAL) AS TOT FROM REGIONAL) SELECT N_NAME, SUPPLY_VAL, ROUND(SUPPLY_VAL / TOT * 100, 2) AS PCT FROM REGIONAL, TOTAL ORDER BY SUPPLY_VAL DESC")

# Fill to 300 complex
templates = [
    ("complex_ntile_quartile", "complex",
     "Segment all parts into 4 price quartiles using NTILE and count parts in each quartile.",
     "SELECT QUARTILE, COUNT(*) AS CNT FROM (SELECT NTILE(4) OVER (ORDER BY P_RETAILPRICE) AS QUARTILE FROM PART) GROUP BY QUARTILE ORDER BY QUARTILE"),
    ("complex_exists_subquery", "complex",
     "Find suppliers that supply at least one part with retail price above 1500.",
     "SELECT DISTINCT S.S_NAME FROM SUPPLIER S WHERE EXISTS (SELECT 1 FROM PARTSUPP PS JOIN PART P ON PS.PS_PARTKEY = P.P_PARTKEY WHERE PS.PS_SUPPKEY = S.S_SUPPKEY AND P.P_RETAILPRICE > 1500)"),
    ("complex_pivot_ship", "complex",
     "Show total quantity shipped per year and per ship mode as a pivot (rows=year, cols aggregated).",
     "SELECT EXTRACT(YEAR FROM L_SHIPDATE) AS YR, L_SHIPMODE, SUM(L_QUANTITY) AS QTY FROM LINEITEM GROUP BY EXTRACT(YEAR FROM L_SHIPDATE), L_SHIPMODE ORDER BY YR, L_SHIPMODE"),
    ("complex_dense_rank", "complex",
     "Rank all nations by their total customer account balance using DENSE_RANK.",
     "SELECT N.N_NAME, SUM(C.C_ACCTBAL) AS TOTAL_BAL, DENSE_RANK() OVER (ORDER BY SUM(C.C_ACCTBAL) DESC) AS DR FROM CUSTOMER C JOIN NATION N ON C.C_NATIONKEY = N.N_NATIONKEY GROUP BY N.N_NAME ORDER BY DR"),
    ("complex_self_join", "complex",
     "Find pairs of customers from the same nation who have placed orders on the same date.",
     "SELECT C1.C_NAME, C2.C_NAME, O1.O_ORDERDATE, N.N_NAME FROM ORDERS O1 JOIN ORDERS O2 ON O1.O_ORDERDATE = O2.O_ORDERDATE AND O1.O_CUSTKEY < O2.O_CUSTKEY JOIN CUSTOMER C1 ON O1.O_CUSTKEY = C1.C_CUSTKEY JOIN CUSTOMER C2 ON O2.O_CUSTKEY = C2.C_CUSTKEY JOIN NATION N ON C1.C_NATIONKEY = N.N_NATIONKEY WHERE C1.C_NATIONKEY = C2.C_NATIONKEY FETCH FIRST 20 ROWS ONLY"),
    ("complex_percent_rank", "complex",
     "For each line item, calculate the percent rank of its extended price within its order.",
     "SELECT L_ORDERKEY, L_LINENUMBER, L_EXTENDEDPRICE, PERCENT_RANK() OVER (PARTITION BY L_ORDERKEY ORDER BY L_EXTENDEDPRICE) AS PCT_RANK FROM LINEITEM FETCH FIRST 100 ROWS ONLY"),
    ("complex_moving_avg", "complex",
     "Calculate a 3-month moving average of order count for the year 1996.",
     "WITH MONTHLY AS (SELECT EXTRACT(MONTH FROM O_ORDERDATE) AS MON, COUNT(*) AS CNT FROM ORDERS WHERE EXTRACT(YEAR FROM O_ORDERDATE) = 1996 GROUP BY EXTRACT(MONTH FROM O_ORDERDATE)) SELECT MON, CNT, AVG(CNT) OVER (ORDER BY MON ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS MOVING_AVG FROM MONTHLY ORDER BY MON"),
    ("complex_lateral_join", "complex",
     "For each customer, find their single most recent order date.",
     "SELECT C.C_NAME, LATEST.O_ORDERDATE FROM CUSTOMER C CROSS APPLY (SELECT O_ORDERDATE FROM ORDERS O WHERE O.O_CUSTKEY = C.C_CUSTKEY ORDER BY O_ORDERDATE DESC FETCH FIRST 1 ROW ONLY) LATEST FETCH FIRST 50 ROWS ONLY"),
    ("complex_ratio_to_report", "complex",
     "Show each nation's share of total lineitem revenue using RATIO_TO_REPORT.",
     "SELECT N.N_NAME, SUM(L.L_EXTENDEDPRICE) AS REV, RATIO_TO_REPORT(SUM(L.L_EXTENDEDPRICE)) OVER () AS SHARE FROM LINEITEM L JOIN ORDERS O ON L.L_ORDERKEY = O.O_ORDERKEY JOIN CUSTOMER C ON O.O_CUSTKEY = C.C_CUSTKEY JOIN NATION N ON C.C_NATIONKEY = N.N_NATIONKEY GROUP BY N.N_NAME ORDER BY REV DESC"),
    ("complex_first_last_value", "complex",
     "For each order, show the first and last line item extended price using window functions.",
     "SELECT O_ORDERKEY, L_LINENUMBER, L_EXTENDEDPRICE, FIRST_VALUE(L_EXTENDEDPRICE) OVER (PARTITION BY L_ORDERKEY ORDER BY L_LINENUMBER) AS FIRST_PRICE, LAST_VALUE(L_EXTENDEDPRICE) OVER (PARTITION BY L_ORDERKEY ORDER BY L_LINENUMBER ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS LAST_PRICE FROM LINEITEM FETCH FIRST 100 ROWS ONLY"),
]

while len([q for q in questions if q['complexity'] == 'complex']) < 300:
    t = templates[len([q for q in questions if q['complexity'] == 'complex']) % len(templates)]
    cat, cplx, q_text, sql = t
    yr = random.choice(YEARS)
    n_name = random.choice(NATIONS)
    ms = random.choice(MKTSEG)
    # Make variants by substituting values into the question text / SQL
    q_text_v = q_text.replace("1996", str(yr)).replace("BUILDING", ms)
    sql_v = sql.replace("1996", str(yr)).replace("BUILDING", ms)
    add(cat, cplx, q_text_v, sql_v)

# ── Write output ───────────────────────────────────────────────────────────────
payload = {"test_questions": questions}
with open(OUT, "w") as f:
    json.dump(payload, f, indent=2)

# Stats
from collections import Counter
c = Counter(q['complexity'] for q in questions)
print(f"Generated {len(questions)} questions -> {OUT}")
print(f"  simple={c['simple']}  medium={c['medium']}  complex={c['complex']}")
