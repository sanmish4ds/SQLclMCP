# Connect SQLcl to Oracle Autonomous Database

A step-by-step guide for anyone getting started with SQLcl and Oracle Cloud Free Tier.

---

## Step 1: Create a Free Oracle Cloud Account

1. Go to [https://www.oracle.com/cloud/free/](https://www.oracle.com/cloud/free/) and click **Start for free**
2. Fill in your name, email, and choose a **home region** (pick one close to you — it cannot be changed later)
3. Verify your email, then complete phone and credit card verification
   > A credit card is required for identity verification only — you will **not** be charged on the Always Free tier
4. Log in to the OCI Console at [https://cloud.oracle.com](https://cloud.oracle.com)

---

## Step 2: Create a Free Autonomous Database

1. In the OCI Console, go to **☰ → Oracle Database → Autonomous Database**
2. Click **Create Autonomous Database**
3. Fill in the form:
   | Field | Value |
   |---|---|
   | Display / Database name | e.g. `prishivdb1` |
   | Workload type | Transaction Processing or Data Warehouse |
   | Deployment type | Serverless |
   | Always Free | **Toggle ON** |
   | Database version | 23ai (latest) |
   | Admin password | Choose a strong password and save it |
   | Network access | Secure access from allowed IPs *(recommended)* |
4. Click **Create Autonomous Database** and wait ~2 minutes for the status to show **Available**

---

## Step 3: Download the Wallet

The wallet contains the TLS certificates and connection config needed to connect securely.

1. On the ADB details page, click **Database connection**
2. Click **Download wallet** and set a wallet password
3. Extract the downloaded zip to a local folder, e.g.:
   ```
   ~/Downloads/Wallet_prishivdb_new/
   ```
   The folder will contain files like `tnsnames.ora`, `sqlnet.ora`, `cwallet.sso`, etc.

---

## Step 4: Install SQLcl

SQLcl is Oracle's command-line interface for Oracle Database — a modern replacement for SQL*Plus.

### macOS (Homebrew — recommended)
```bash
brew install sqlcl
```

### Manual Install (macOS / Linux / Windows)
1. Download from: [https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/](https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/)
2. Unzip the archive:
   ```bash
   unzip sqlcl-latest.zip -d ~/sqlcl
   ```
3. Add SQLcl to your PATH — add this line to `~/.zshrc` or `~/.bashrc`:
   ```bash
   export PATH="$HOME/sqlcl/sqlcl/bin:$PATH"
   ```
4. Reload your shell:
   ```bash
   source ~/.zshrc
   ```

> **Note:** Java 11+ is required. Check with `java -version`. Install via `brew install openjdk` if missing.

**Verify the install:**
```bash
sql -v
```
Expected: `SQLcl: Release 25.4.2.0 Production Build: 25.4.2.044.1837`

---

## Step 5: Connect to the Database

Set `TNS_ADMIN` to your wallet folder so SQLcl can find the connection config, then connect:

```bash
TNS_ADMIN=~/Downloads/Wallet_prishivdb_new \
  sql admin/<your-password>@<db-name>_high
```

**Example:**
```bash
TNS_ADMIN=/Users/sanjaymishra/Downloads/Wallet_prishivdb_new \
  sql admin/<your-password>@prishivdb1_high
```

You should see:
```
Connected to:
Oracle AI Database 26ai Enterprise Edition Release 23.26.1.2.0
SQL>
```

You're in! You can now run SQL queries at the `SQL>` prompt.

---

## Connection Reference

| Parameter   | Value                                              |
|-------------|----------------------------------------------------|
| DB_USER     | admin                                              |
| DB_DSN      | prishivdb1_high                                    |
| WALLET_PATH | /Users/sanjaymishra/Downloads/Wallet_prishivdb_new |
| TNS_ADMIN   | /Users/sanjaymishra/Downloads/Wallet_prishivdb_new |
| Host        | adb.us-ashburn-1.oraclecloud.com                   |
| Port        | 1522                                               |

---

## Troubleshooting

### Issue 1: `sqlnet.ora` has a broken wallet path

**Symptom:** Connection fails with SSL/wallet errors right away.

**Cause:** The `sqlnet.ora` file downloaded from OCI uses `?` as a placeholder for the wallet directory instead of the real path.

**Fix:** Replace the placeholder with the actual path to your wallet folder:
```bash
sed -i '' 's|DIRECTORY="?/network/admin"|DIRECTORY="/Users/sanjaymishra/Downloads/Wallet_prishivdb_new"|' \
  ~/Downloads/Wallet_prishivdb_new/sqlnet.ora
```

Confirm the fix:
```bash
cat ~/Downloads/Wallet_prishivdb_new/sqlnet.ora
# Should show:
# WALLET_LOCATION = (SOURCE = (METHOD = file) (METHOD_DATA = (DIRECTORY="/Users/...")))
```

---

### Issue 2: `ORA-12506` — Connection rejected by ACL

**Symptom:**
```
Error Message = ORA-12506: TNS:listener rejected connection based on service ACL filtering
```

**Cause:** The ADB's Access Control List (ACL) only allows connections from whitelisted IPs. Your current IP is not on the list.

**Fix:**

1. Find your public IP:
   ```bash
   curl -s https://checkip.amazonaws.com
   ```

2. In OCI Console, go to **Autonomous Database → prishivdb1 → Network**
3. Click **Edit** next to **Access Control List**
4. Add your IP in CIDR notation, e.g. `203.0.113.10/32`
5. Save — the change takes ~30 seconds to apply, then retry the connection
