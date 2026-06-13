# Canvas Server Authentication

Canvas Server supports multiple authentication strategies to provide flexible user access control. This document covers all available authentication methods, configuration options, and best practices.

## Table of Contents

- [Overview](#overview)
- [Authentication Strategies](#authentication-strategies)
- [Configuration](#configuration)
- [Local Authentication](#local-authentication)
- [IMAP Authentication](#imap-authentication)
- [LDAP / Active Directory Authentication](#ldap--active-directory-authentication)
- [TLS/SSL Configuration](#tlsssl-configuration)
- [API Reference](#api-reference)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

## Overview

Canvas Server provides a unified authentication system that supports:

- **Local Authentication**: Traditional email/password with local user accounts
- **IMAP Authentication**: Authentication against external email servers with auto-user creation
- **LDAP / Active Directory**: Directory bind authentication with auto-user creation (AD uses the LDAP strategy)
- **JWT Tokens**: Secure session management
- **API Tokens**: Long-lived tokens for programmatic access

## Authentication Strategies

### Strategy Selection

Authentication strategies are automatically selected based on:

1. **Auto-detection** (default): Determines the best strategy based on user existence and domain configuration
2. **Explicit strategy**: Users can specify `local`, `imap`, `ldap`, or `auto` during login
3. **Domain-based routing**: IMAP domains are automatically detected from email addresses; LDAP is used when enabled and no local user exists

### Flow Diagram

```
User Login Request
        ↓
   Strategy = "auto"?
        ↓
   Check existing user
        ↓
User exists? → Yes → Use existing auth method (local/imap/ldap)
        ↓ No
   LDAP enabled?
        ↓ Yes → Use LDAP authentication
        ↓ No
   Check IMAP domain config
        ↓
Domain configured? → Yes → Use IMAP authentication
        ↓ No
   Use local authentication
```

## Configuration

Authentication is configured in `server/config/auth.json`:

```json
{
  "strategies": {
    "local": {
      "enabled": true,
      "allowRegistration": true
    },
    "imap": {
      "enabled": true,
      "autoCreateUsers": true,
      "defaultUserType": "user",
      "defaultStatus": "active",
      "domains": {
        // Domain configurations here
      }
    },
    "ldap": {
      "enabled": false,
      "servers": {
        "primary": {
          "url": "ldaps://dc.example.com:636",
          "bindDN": "CN=svc-canvas,OU=Service Accounts,DC=example,DC=com",
          "bindPassword": "",
          "searchBase": "DC=example,DC=com",
          "searchFilter": "(&(objectClass=user)(userPrincipalName={{email}}))",
          "attributes": ["mail", "cn", "displayName", "memberOf"],
          "tls": true
        }
      },
      "defaultUserType": "user",
      "defaultStatus": "active"
    }
  },
  "defaultStrategy": "local",
  "session": {
    "jwtExpiry": "7d",
    "refreshTokenExpiry": "30d"
  }
}
```

### Global Settings

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| `defaultStrategy` | string | Default authentication strategy | `"local"` |
| `session.jwtExpiry` | string | JWT token expiration time | `"7d"` |
| `session.refreshTokenExpiry` | string | Refresh token expiration time | `"30d"` |

## Local Authentication

Local authentication uses traditional email/password combinations with user accounts stored in the Canvas Server database.

### Configuration

```json
{
  "strategies": {
    "local": {
      "enabled": true,
      "allowRegistration": true
    }
  }
}
```

### Features

- **User Registration**: Create new accounts via `/auth/register`
- **Password Management**: Change passwords, reset functionality
- **Email Verification**: Optional email verification workflow
- **User Management**: Full CRUD operations on user accounts

### API Endpoints

- `POST /auth/login` - Login with email/password
- `POST /auth/register` - Register new user account
- `PUT /auth/password` - Change password (authenticated)
- `POST /auth/forgot-password` - Request password reset
- `POST /auth/reset-password` - Reset password with token

## IMAP Authentication

IMAP authentication allows users to login using their existing email credentials. When a user successfully authenticates via IMAP, Canvas Server automatically creates a local user account.

### Configuration

```json
{
  "strategies": {
    "imap": {
      "enabled": true,
      "autoCreateUsers": true,
      "defaultUserType": "user",
      "defaultStatus": "active",
      "domains": {
        "company.com": {
          "host": "mail.company.com",
          "port": 993,
          "secure": true,
          "domain": "company.com",
          "name": "Company Mail Server"
        }
      }
    }
  }
}
```

### Domain Configuration

Each domain in the `domains` object supports these properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `host` | string | ✅ | IMAP server hostname |
| `port` | number | ✅ | IMAP server port |
| `secure` | boolean | ✅ | Use SSL/TLS from connection start |
| `domain` | string | ✅ | Email domain (must match key) |
| `name` | string | ✅ | Human-readable server name |
| `startTLS` | boolean | ❌ | Upgrade to TLS after plain connection |
| `requireAppPassword` | boolean | ❌ | Indicates app-specific passwords required |
| `tlsOptions` | object | ❌ | Advanced TLS configuration |

### Auto-User Creation

When IMAP authentication succeeds, Canvas Server automatically:

1. Creates a new user account with the authenticated email
2. Sets up the user's workspace and default context
3. Assigns the configured user type and status
4. Stores IMAP server information for future reference

### User Properties

Auto-created IMAP users have these properties:

```json
{
  "email": "user@company.com",
  "userType": "user",
  "status": "active",
  "authMethod": "imap",
  "imapDomain": "company.com",
  "imapServer": "mail.company.com",
  "name": "user",
  "created": "2024-01-01T00:00:00.000Z",
  "updated": "2024-01-01T00:00:00.000Z"
}
```

## LDAP / Active Directory Authentication

LDAP authentication is **implemented and available**. Active Directory is not a separate strategy — AD exposes an LDAP interface, so you configure `strategies.ldap` and point it at your domain controller.

Implementation: `src/transports/auth/ldap-strategy.js` (uses the `ldapjs` package, already in `package.json`).

### How it works

1. Service account (optional) binds to LDAP and searches for the user by email
2. User is authenticated with a second bind using their DN + password
3. On success, Canvas creates a local user record if one does not exist (`authMethod: "ldap"`)
4. Multiple servers (`primary`, `secondary`, …) are tried in order for failover

Login with `"strategy": "ldap"` or `"strategy": "auto"`. When `auto` is used and LDAP is enabled, **new** users (no existing local record) are routed to LDAP before IMAP/local.

### Configuration

Edit `server/config/auth.json` (created automatically on first run if missing):

```json
{
  "strategies": {
    "ldap": {
      "enabled": true,
      "servers": {
        "primary": {
          "url": "ldaps://dc.example.com:636",
          "bindDN": "CN=svc-canvas,OU=Service Accounts,DC=example,DC=com",
          "bindPassword": "service-account-password",
          "searchBase": "DC=example,DC=com",
          "searchFilter": "(&(objectClass=user)(userPrincipalName={{email}}))",
          "attributes": ["mail", "cn", "displayName", "memberOf"],
          "tls": true
        }
      },
      "defaultUserType": "user",
      "defaultStatus": "active"
    }
  }
}
```

### Server properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | string | ✅ | LDAP URL (`ldap://host:389` or `ldaps://host:636`) |
| `searchBase` | string | ✅ | LDAP search base (e.g. `DC=corp,DC=local`) |
| `searchFilter` | string | ✅ | Filter with `{{email}}` placeholder |
| `bindDN` | string | ❌ | Service account DN for user lookup (recommended for AD) |
| `bindPassword` | string | ❌ | Service account password |
| `attributes` | string[] | ❌ | Attributes to fetch (default: `mail`, `cn`, `displayName`) |
| `tls` | boolean | ❌ | Enable TLS options on the client (use `true` with `ldaps://`) |

Global LDAP settings:

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `enabled` | boolean | Enable LDAP login | `false` |
| `defaultUserType` | string | User type for auto-created accounts | `"user"` |
| `defaultStatus` | string | Status for auto-created accounts | `"active"` |

### Active Directory setup

Typical AD configuration:

```json
{
  "strategies": {
    "local": {
      "enabled": false,
      "allowRegistration": false
    },
    "ldap": {
      "enabled": true,
      "servers": {
        "primary": {
          "url": "ldaps://dc01.corp.example.com:636",
          "bindDN": "CN=canvas-svc,OU=Service Accounts,DC=corp,DC=example,DC=com",
          "bindPassword": "…",
          "searchBase": "DC=corp,DC=example,DC=com",
          "searchFilter": "(&(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(mail={{email}}))",
          "attributes": ["mail", "cn", "displayName", "memberOf", "sAMAccountName"],
          "tls": true
        }
      },
      "defaultUserType": "user",
      "defaultStatus": "active"
    }
  },
  "defaultStrategy": "ldap"
}
```

**Search filter options** (pick one that matches how users log in):

| Login identifier | Example filter |
|------------------|----------------|
| Email / UPN | `(&(objectClass=user)(userPrincipalName={{email}}))` |
| Email attribute | `(&(objectClass=user)(mail={{email}}))` |
| sAMAccountName | `(&(objectClass=user)(sAMAccountName={{email}}))` — user must enter `jdoe`, not `jdoe@corp.example.com` |

The `(!(userAccountControl:…:=2))` clause excludes disabled AD accounts.

**Service account**: Create a dedicated AD user with read access to the search base. Do not use a domain admin account.

### OpenLDAP example

```json
{
  "url": "ldap://ldap.example.com:389",
  "bindDN": "cn=admin,dc=example,dc=com",
  "bindPassword": "…",
  "searchBase": "ou=users,dc=example,dc=com",
  "searchFilter": "(mail={{email}})",
  "attributes": ["mail", "cn", "displayName"],
  "tls": false
}
```

### API

Same login endpoint as other strategies:

```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@corp.example.com",
  "password": "password",
  "strategy": "ldap"
}
```

Check whether LDAP is enabled:

```http
GET /auth/config
```

Response includes `"ldap": { "enabled": true }`.

### What's not implemented yet

These are gaps if you need full enterprise AD integration:

| Gap | Notes |
|-----|-------|
| **No domain-based LDAP routing** | Unlike IMAP, enabling LDAP applies to all new users in `auto` mode — no per-domain server map |
| **No AD group → Canvas role mapping** | `memberOf` is fetched but not used for authorization |
| **No Kerberos / SSO / NTLM** | Password bind only; no Windows integrated auth |
| **No username-without-domain login** | Filter uses `{{email}}` as-is; sAMAccountName login requires filter + UX changes |
| **Limited TLS config** | `tls: true` sets `rejectUnauthorized: false` — fine for dev, tighten for production |
| **Bind password in config file** | No env-var / secret-manager indirection yet |
| **No `autoCreateUsers` toggle** | Users are always auto-created on first successful LDAP bind (same as IMAP default behaviour) |

For most AD deployments, enabling LDAP with a service account + UPN/mail filter is enough to get login working today. Group-based roles and SSO would be separate follow-up work.

## TLS/SSL Configuration

Canvas Server supports multiple TLS/SSL configurations for secure IMAP connections.

### SSL/TLS (Direct Encryption) ⭐ Recommended

```json
{
  "host": "imap.gmail.com",
  "port": 993,
  "secure": true,
  "domain": "gmail.com",
  "name": "Gmail (SSL/TLS)"
}
```

- **Most secure**: Connection encrypted from start
- **Standard port**: 993 (IMAPS)
- **Best for**: Production environments

### STARTTLS (Upgrade to TLS)

```json
{
  "host": "mail.company.com",
  "port": 143,
  "secure": false,
  "startTLS": true,
  "domain": "company.com",
  "name": "Company Mail Server (STARTTLS)"
}
```

- **Good security**: Plain connection upgraded to TLS
- **Standard port**: 143 (IMAP)
- **Best for**: Legacy servers that don't support direct SSL

### Custom TLS Options

```json
{
  "host": "outlook.office365.com",
  "port": 993,
  "secure": true,
  "domain": "outlook.com",
  "name": "Microsoft Outlook",
  "tlsOptions": {
    "servername": "outlook.office365.com",
    "rejectUnauthorized": true,
    "minVersion": "TLSv1.2",
    "maxVersion": "TLSv1.3",
    "ciphers": "HIGH:!aNULL:!MD5"
  }
}
```

### TLS Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `rejectUnauthorized` | boolean | Reject self-signed certificates |
| `servername` | string | SNI hostname for multi-domain certificates |
| `minVersion` | string | Minimum TLS version (`TLSv1.2`, `TLSv1.3`) |
| `maxVersion` | string | Maximum TLS version |
| `ciphers` | string | Allowed cipher suites |
| `checkServerIdentity` | function | Custom certificate validation |

### Development/Testing (Insecure)

```json
{
  "host": "mail.local",
  "port": 143,
  "secure": false,
  "startTLS": false,
  "domain": "local.test",
  "name": "Local Test Server",
  "tlsOptions": {
    "rejectUnauthorized": false
  }
}
```

⚠️ **Warning**: Only use insecure configurations for development/testing environments.

## Popular Email Providers

### Gmail

```json
{
  "host": "imap.gmail.com",
  "port": 993,
  "secure": true,
  "domain": "gmail.com",
  "name": "Gmail",
  "requireAppPassword": true
}
```

**Note**: Gmail requires app-specific passwords when 2FA is enabled.

### Microsoft Outlook/Office 365

```json
{
  "host": "outlook.office365.com",
  "port": 993,
  "secure": true,
  "domain": "outlook.com",
  "name": "Microsoft Outlook",
  "tlsOptions": {
    "servername": "outlook.office365.com"
  }
}
```

### Yahoo Mail

```json
{
  "host": "imap.mail.yahoo.com",
  "port": 993,
  "secure": true,
  "domain": "yahoo.com",
  "name": "Yahoo Mail"
}
```

### Custom Corporate Server

```json
{
  "host": "mail.yourcompany.com",
  "port": 143,
  "secure": false,
  "startTLS": true,
  "domain": "yourcompany.com",
  "name": "Your Company Mail"
}
```

## API Reference

### Authentication Endpoints

#### Get Authentication Configuration

```http
GET /auth/config
```

Returns available authentication strategies and IMAP domains.

**Response:**
```json
{
  "status": "success",
  "payload": {
    "strategies": {
      "local": { "enabled": true },
      "imap": {
        "enabled": true,
        "domains": [
          {
            "domain": "company.com",
            "name": "Company Mail Server",
            "requireAppPassword": false
          }
        ]
      },
      "ldap": {
        "enabled": true
      }
    }
  }
}
```

#### Login

```http
POST /auth/login
```

**Request Body:**
```json
{
  "email": "user@company.com",
  "password": "password123",
  "strategy": "auto"  // Optional: "local", "imap", "ldap", "auto"
}
```

**Response:**
```json
{
  "status": "success",
  "payload": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "user-uuid",
      "email": "user@company.com",
      "name": "user",
      "authMethod": "imap"
    }
  }
}
```

#### Current User

```http
GET /auth/me
Authorization: Bearer <token>
```

**Response:**
```json
{
  "status": "success",
  "payload": {
    "id": "user-uuid",
    "email": "user@company.com",
    "userType": "user",
    "status": "active"
  }
}
```

### Error Responses

Common error responses include:

| Error | HTTP Status | Description |
|-------|-------------|-------------|
| `Invalid email or password` | 401 | Invalid credentials for local auth |
| `Unsupported login domain` | 400 | Domain not configured for IMAP |
| `Email server authentication failed` | 401 | IMAP server rejected credentials |
| `LDAP authentication failed` | 401 | LDAP bind or search failed |
| `LDAP authentication not configured properly` | 400 | LDAP enabled but misconfigured or `ldapjs` missing |
| `User account is not active` | 401 | User account disabled |

## Security Considerations

### Best Practices

1. **Use TLS/SSL**: Always use `secure: true` for production
2. **Certificate Validation**: Keep `rejectUnauthorized: true` in production
3. **Strong Passwords**: Enforce password complexity for local accounts
4. **Token Management**: Implement proper token rotation and expiration
5. **Rate Limiting**: Implement login attempt rate limiting
6. **Audit Logging**: Log authentication events for security monitoring

### Security Headers

Ensure your reverse proxy sets appropriate security headers:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
```

### Password Requirements

For local authentication, enforce:

- Minimum 8 characters
- Mix of uppercase, lowercase, numbers
- Special characters recommended
- Regular password rotation

## Troubleshooting

### Common Issues

#### IMAP Connection Fails

**Symptoms**: `IMAP authentication failed` errors

**Solutions**:
1. Verify server hostname and port
2. Check TLS/SSL configuration
3. Test credentials manually with email client
4. Review server firewall settings
5. Check for app-specific password requirements

#### Certificate Validation Errors

**Symptoms**: `certificate verification failed` errors

**Solutions**:
1. Verify certificate chain is complete
2. Check SNI configuration with `servername` option
3. For testing only: set `rejectUnauthorized: false`
4. Update certificate if expired

#### Auto-User Creation Fails

**Symptoms**: IMAP auth succeeds but user creation fails

**Solutions**:
1. Check user manager initialization
2. Verify database connectivity
3. Review user creation permissions
4. Check for email uniqueness constraints

#### LDAP / AD Login Fails

**Symptoms**: `LDAP authentication failed`, `User not found in LDAP directory`, or `LDAP bind failed`

**Solutions**:
1. Verify `url`, `searchBase`, and `searchFilter` against your directory (test with `ldapsearch`)
2. Confirm the service account (`bindDN` / `bindPassword`) can search the base
3. For AD: match filter to login format (UPN vs `mail` vs sAMAccountName)
4. Use `ldaps://` on port 636 (or LDAP + StartTLS if you add that support later)
5. Check firewall paths from Canvas server to domain controller
6. Ensure `ldapjs` is installed (`npm install` — it is a declared dependency)
7. Set `"enabled": true` under `strategies.ldap` and restart the server

### Debugging

Enable debug logging:

```bash
DEBUG=canvas-server:auth npm run dev
```

Log levels:
- `ERROR`: Authentication failures and errors
- `INFO`: Successful authentications and user creation
- `DEBUG`: Detailed IMAP connection information

### Log Examples

**Successful IMAP Authentication**:
```
[IMAP] Attempting authentication for user@company.com against mail.company.com
[IMAP] Connection config: mail.company.com:993 (secure: true, startTLS: false)
[IMAP] Successfully authenticated user@company.com
[IMAP] Creating user for user@company.com
[IMAP] Successfully created user: user-uuid-1234
```

**Failed Authentication**:
```
[IMAP] Authentication failed for user@company.com: Invalid credentials
[Auth/Login] IMAP authentication failed: IMAP authentication failed: Invalid credentials
```

**Successful LDAP Authentication**:
```
[LDAP] Attempting authentication for user@corp.example.com against ldaps://dc01.corp.example.com:636
[LDAP] Found user: CN=Jane Doe,OU=Users,DC=corp,DC=example,DC=com
[LDAP] Successfully authenticated user@corp.example.com
[LDAP] Successfully created user: user@corp.example.com
```

## Configuration Examples

### Small Business Setup

```json
{
  "strategies": {
    "local": {
      "enabled": true,
      "allowRegistration": false
    },
    "imap": {
      "enabled": true,
      "autoCreateUsers": true,
      "defaultUserType": "user",
      "defaultStatus": "active",
      "domains": {
        "mybusiness.com": {
          "host": "mail.mybusiness.com",
          "port": 993,
          "secure": true,
          "domain": "mybusiness.com",
          "name": "My Business Mail"
        }
      }
    }
  },
  "defaultStrategy": "auto"
}
```

### Enterprise Setup

```json
{
  "strategies": {
    "local": {
      "enabled": false,
      "allowRegistration": false
    },
    "imap": {
      "enabled": true,
      "autoCreateUsers": true,
      "defaultUserType": "user",
      "defaultStatus": "active",
      "domains": {
        "company.com": {
          "host": "outlook.office365.com",
          "port": 993,
          "secure": true,
          "domain": "company.com",
          "name": "Company Email",
          "tlsOptions": {
            "servername": "outlook.office365.com"
          }
        },
        "contractors.company.com": {
          "host": "mail.company.com",
          "port": 143,
          "secure": false,
          "startTLS": true,
          "domain": "contractors.company.com",
          "name": "Contractor Email"
        }
      }
    }
  },
  "defaultStrategy": "imap"
}
```

### Development Setup

```json
{
  "strategies": {
    "local": {
      "enabled": true,
      "allowRegistration": true
    },
    "imap": {
      "enabled": true,
      "autoCreateUsers": true,
      "defaultUserType": "admin",
      "defaultStatus": "active",
      "domains": {
        "test.local": {
          "host": "mailhog",
          "port": 1143,
          "secure": false,
          "startTLS": false,
          "domain": "test.local",
          "name": "Local Test Server",
          "tlsOptions": {
            "rejectUnauthorized": false
          }
        }
      }
    }
  },
  "defaultStrategy": "local"
}
```

---

For more information about API tokens and programmatic access, see [API Token Authentication](./api-token-auth.md). 
