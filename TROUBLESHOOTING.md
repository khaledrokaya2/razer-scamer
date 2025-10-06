# SQL Server Connection Troubleshooting Guide

## Current Status

✅ SQL Server (MSSQLSERVER) is **RUNNING**
❌ SQL Server Browser is **STOPPED** (not critical for default instance)

## Problem Identified

The database connection is failing because:
1. The server name "." in the `.env` file is not being resolved properly by the `mssql` Node.js library
2. The DatabaseService is configured to use Windows Authentication but the connection is timing out

## Solutions

### Solution 1: Use localhost or 127.0.0.1 (RECOMMENDED)

Update your `.env` file:

```env
DB_SERVER=localhost
# OR
DB_SERVER=127.0.0.1
```

### Solution 2: Use Named Pipes

Update your `DatabaseService.js` to use Named Pipes connection:

```javascript
this.config = {
  server: '\\\\.\\pipe\\MSSQL$MSSQLSERVER\\sql\\query',
  database: process.env.DB_NAME,
  options: {
    trustServerCertificate: true,
    enableArithAbort: true,
    encrypt: false
  },
  authentication: {
    type: 'default'
  }
};
```

### Solution 3: Enable TCP/IP Protocol

1. Open **SQL Server Configuration Manager**
2. Go to **SQL Server Network Configuration** > **Protocols for MSSQLSERVER**
3. Right-click **TCP/IP** and select **Enable**
4. Right-click **TCP/IP** and select **Properties**
5. Go to **IP Addresses** tab
6. Scroll down to **IPAll**
7. Set **TCP Port** to `1433`
8. Click **OK**
9. Restart the **SQL Server (MSSQLSERVER)** service

### Solution 4: Start SQL Server Browser (Optional)

If you're using named instances, start the SQL Server Browser service:

```powershell
Start-Service -Name "SQLBrowser"
Set-Service -Name "SQLBrowser" -StartupType Automatic
```

## Quick Fix

I'll update your .env file to use `localhost` instead of `.`
