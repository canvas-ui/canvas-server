We need to make canvas-server more secure

1) Review the current auth implementation in ./src/api/auth and ./src/api/routes, ./src/api/middleware/workspace-acl.js with the 3 supported auth strategies - JWT(user+pass), API Token, IMAP - for security best prectices

2) Implement toggable email address validation on user registration for non-IMAP accounts using a simple email + link
- This requires a dedicated smtp configration in server/config/smtp.json, defaults to sendmail
- Draft/idea server/config/auth.json
  - local
    enabled: bool, default true
    requireEmailVerification: bool, default false

3) We'll need to harden the register and login pages in the canvas-web submodule 

Current Security Issues:
- JWT Secret: Hardcoded default secret in production code
- Password Policy: No complexity requirements
- Email Verification: Not implemented for local accounts
- Rate Limiting: No rate limiting on auth endpoints
- Input Validation: Some endpoints lack proper validation
- Error Messages: Some error messages may leak information

### 1. Authentication Security

#### Password Policy
- **Minimum Length**: 8 characters (configurable)
- **Complexity Requirements**: 
  - Uppercase letters (A-Z)
  - Lowercase letters (a-z)
  - Numbers (0-9)
  - Special characters (!@#$%^&*()_+-=[]{};:,./<>?)
- **Weak Password Detection**: Blocks common weak passwords
- **Maximum Length**: 128 characters

#### JWT Token Security
- **Secure Secret Generation**: Uses crypto.randomBytes(64) for JWT secrets
- **Token Expiration**: Configurable expiration (default: 7 days)
- **Token Versioning**: Includes user version for invalidation on data changes
- **Secret Validation**: Warns about insecure default secrets

#### API Token Security
- **Secure Generation**: Uses crypto.randomBytes(24) for token values
- **SHA-256 Hashing**: Tokens are stored as SHA-256 hashes
- **Expiration Support**: Configurable token expiration
- **Prefix Identification**: API tokens use "canvas-" prefix


### 2. Email Verification

#### Toggleable Email Verification
- **Configuration**: Enable/disable via `server/config/auth.json`
- **User Status**: Pending users cannot log in until verified
- **Token Expiration**: 48-hour expiration for verification tokens
- **Email Templates**: Configurable HTML and text templates

#### SMTP Configuration
- **Flexible Setup**: Supports custom SMTP or system sendmail
- **Fallback Support**: Automatic fallback to system SMTP
- **Template Variables**: Support for dynamic content in emails

### 3. Rate Limiting

#### Login Protection
- **Max Attempts**: 5 attempts per 15 minutes (configurable)
- **Lockout Duration**: 30 minutes after max attempts

#### Registration Protection
- **Max Attempts**: 3 attempts per hour (configurable)
- **Prevents Abuse**: Protects against automated registration

#### Password Reset Protection
- **Max Attempts**: 3 attempts per hour (configurable)
- **Prevents Abuse**: Protects against email bombing

#### API Operations Protection
- **Token Management**: 10 operations per 5 minutes (configurable)
- **Password Changes**: 10 operations per 5 minutes (configurable)
- **Prevents Abuse**: Protects against token enumeration

#### Token Operations Protection
- **Email Verification**: 5 attempts per 5 minutes (configurable)
- **Password Reset**: 5 attempts per 5 minutes (configurable)
- **Token Verification**: 5 attempts per 5 minutes (configurable)

#### User Profile Protection
- **Profile Access**: 60 requests per minute (configurable)
- **Prevents Abuse**: Protects against profile scraping

### 4. Input Validation & Sanitization

#### Email Validation
- **Format Validation**: RFC-compliant email format checking (ReDoS-safe)
- **Sanitization**: Automatic lowercase conversion and trimming
- **Domain Validation**: IMAP domain-specific validation
- **Security**: Uses safe regex patterns to prevent ReDoS attacks

#### Username Validation
- **Format**: 3-24 characters, lowercase letters, numbers, underscores, hyphens, dots
- **Reserved Names**: Blocks system-reserved usernames
- **Pattern Matching**: Strict regex validation

### 5. Security Headers

#### HTTP Security Headers
- **X-Content-Type-Options**: nosniff
- **X-Frame-Options**: DENY
- **X-XSS-Protection**: 1; mode=block
- **Referrer-Policy**: strict-origin-when-cross-origin
- **Permissions-Policy**: Restricts geolocation, microphone, camera
- **Content-Security-Policy**: Comprehensive CSP rules
- **HSTS**: HTTP Strict Transport Security (production only)

### 6. Error Handling

#### Information Disclosure Prevention
- **Generic Messages**: Login errors don't reveal user existence
- **Sanitized Errors**: No sensitive data in error responses
- **Logging**: Secure logging without sensitive data exposure

## Configuration Files

### server/config/auth.json
```json
{
  "strategies": {
    "local": {
      "enabled": true,
      "requireEmailVerification": false,
      "passwordPolicy": {
        "minLength": 12,
        "requireUppercase": true,
        "requireLowercase": true,
        "requireNumbers": true,
        "requireSpecialChars": true,
        "maxLength": 128
      },
      "rateLimiting": {
        "loginAttempts": {
          "maxAttempts": 5,
          "windowMs": 900000,
          "lockoutDuration": 1800000
        },
        "registration": {
          "maxAttempts": 3,
          "windowMs": 3600000
        },
        "passwordReset": {
          "maxAttempts": 3,
          "windowMs": 3600000
        },
        "apiOperations": {
          "maxAttempts": 10,  
          "windowMs": 300000
        },
        "tokenOperations": {
          "maxAttempts": 5,
          "windowMs": 300000
        },
        "userProfile": {
          "maxAttempts": 30,
          "windowMs": 60000
        }
      }
    }
  },
  "jwt": {
    "secret": "your-secure-jwt-secret-here",
    "expiresIn": "1d"
  }
}
```

### server/config/smtp.json
```json
{
  "enabled": true,
  "host": "smtp.example.com",
  "port": 587,
  "secure": true,
  "auth": {
    "user": "your-email@example.com",
    "pass": "your-password"
  },
  "from": {
    "name": "Canvas Server",
    "email": "noreply@example.com"
  }
}
```

## Dependency vulnerability triage — 2026-08-16

`npm audit` baseline was 20 findings (1 critical). After this pass: 16 (1 critical, accepted — see below). Fixed in v2.5.29:

- **fast-uri host-confusion chain** (ajv / fast-json-stringify / @fastify/ajv-compiler): the existing `fast-uri` override sat at 3.1.2 — *inside* the vulnerable range — bumped to **3.1.5** (patched).
- **adm-zip** (4GB-allocation DoS): was a direct dependency with zero imports anywhere — removed. (Still present transitively via canvas-inferd → onnxruntime-node.)

Accepted / deferred, in priority order:

1. **tar ≤7.5.20 (CRITICAL, via fastembed 2.1.0)** — no patched tar v6 exists and fastembed (latest) pins `^6.2.0` with `import tar from "tar"`, which breaks on tar v7 (no default export; verified: overriding kills the ONNX embeddings worker). Exploitation requires a malicious model archive, i.e. a compromised HuggingFace CDN or MITM past TLS — low likelihood, high impact. **Fix path: upstream fastembed PR** (`import * as tar from "tar"` + tar ^7), then bump fastembed in canvas-synapsd + canvas-inferd.
2. **Fastify v4 EOL set** (fastify ≤5.8.2 DoS + content-type bypass, find-my-way HTTP/2 DDoS, @fastify/static route-guard bypass, fastify-socket.io): all fixed only in Fastify v5 — needs a planned **v4→v5 migration** (breaking). This is the highest-value follow-up: the server is internet-exposed and v4 no longer receives security patches.
3. **@mariozechner/pi-coding-agent 0.27→0.49** (major): advisories are local-privilege-escalation / auth.json race on *shared* machines — low practical risk on single-user deployments; upgrade needs agent-runtime regression testing.
4. **Git-dep repos**: canvas-inferd (sharp <0.35 libvips CVEs, onnxruntime-node→adm-zip), canvas-stored (image-size — **no patched release exists**, all versions; its use is lazy/optional in extractors, consider gating ICNS/JXL/HEIF), canvas-synapsd (fastembed→tar, same as #1).
