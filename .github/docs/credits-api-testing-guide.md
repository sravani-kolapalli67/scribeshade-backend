# Credits API Testing Guide

This guide explains how to test the Credits feature APIs located at `src/features/credits`. The base URL for these endpoints is `http://localhost:<PORT>/api/credits` (assuming default local setup, often port `8080` or `3000`).

## Prerequisites

1. **Running the Server:** Ensure the backend server is running (`pnpm dev`).
2. **Database:** Ensure your local database is running and migrated (`pnpm db:migrate` or `pnpm db:push`).
3. **Authentication:** Many endpoints are protected by Clerk. You will need a valid **Clerk Bearer Token** for a test user. 
   - *How to get a token:* Log into the frontend application connected to this backend, open the network tab or console, and copy the Bearer token sent in the `Authorization` header of API requests. Alternatively, you can use `await window.Clerk.session.getToken()` in the frontend browser console.
   - Include it in your requests as an HTTP header: `Authorization: Bearer <YOUR_TOKEN>`

---

## 1. Public Endpoints (No Auth Required)

### Get Active Brackets
Fetches all active credit bracket configurations.
- **Endpoint:** `GET /api/credits/brackets`
- **Request (cURL):**
  ```bash
  curl -X GET http://localhost:8080/api/credits/brackets
  ```
- **Expected Response:** `200 OK` with `{ "success": true, "data": [...] }`

### Get Credit Plans
Fetches default credit purchase plans.
- **Endpoint:** `GET /api/credits/plans`
- **Query Params:** `currency` (Optional: `INR` | `USD` | `GBP`. Defaults to `INR`)
- **Request (cURL):**
  ```bash
  curl -X GET "http://localhost:8080/api/credits/plans?currency=USD"
  ```
- **Expected Response:** `200 OK` with `{ "success": true, "data": [...], "feature": "INTERVIEW_SESSION" }`

---

## 2. Authenticated Endpoints

*Note: Replace `<YOUR_TOKEN>` with your actual Clerk session token.*

### Get Credit Balance
Returns the current credit balance of the authenticated user.
- **Endpoint:** `GET /api/credits/balance`
- **Request (cURL):**
  ```bash
  curl -X GET http://localhost:8080/api/credits/balance \
    -H "Authorization: Bearer <YOUR_TOKEN>"
  ```
- **Expected Response:** `200 OK` with `{ "success": true, "data": <number> }`

### Get Credit Ledger
Returns paginated ledger entries (history of credit additions/deductions).
- **Endpoint:** `GET /api/credits/ledger`
- **Query Params:** `page` (default 1), `limit` (default 20, max 100)
- **Request (cURL):**
  ```bash
  curl -X GET "http://localhost:8080/api/credits/ledger?page=1&limit=10" \
    -H "Authorization: Bearer <YOUR_TOKEN>"
  ```
- **Expected Response:** `200 OK` with `{ "success": true, "data": [...], "pagination": { "total": X, "page": 1, ... } }`

### Get Purchase History
Returns the user's history of credit purchases.
- **Endpoint:** `GET /api/credits/purchases`
- **Request (cURL):**
  ```bash
  curl -X GET http://localhost:8080/api/credits/purchases \
    -H "Authorization: Bearer <YOUR_TOKEN>"
  ```
- **Expected Response:** `200 OK` with `{ "success": true, "data": [...] }`

---

## 3. Purchasing Flow Endpoints

Testing the purchase flow requires interactions simulating the Razorpay payment gateway integration.

### Step 3a: Create Purchase Order
Creates a Razorpay order and a pending purchase record in the database.
- **Endpoint:** `POST /api/credits/purchase/order`
- **Body:**
  - `packCode` (string, required) - e.g., `"STARTER"`, `"PRO"`
  - `currency` (string, optional)
- **Request (cURL):**
  ```bash
  curl -X POST http://localhost:8080/api/credits/purchase/order \
    -H "Authorization: Bearer <YOUR_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"packCode": "STARTER", "currency": "INR"}'
  ```
- **Expected Response:** `201 Created` with order details including `razorpayOrderId`.

### Step 3b: Verify Purchase (Mocking successful payment)
Verifies the Razorpay payment signature and credits the user's balance. In a local test environment, you typically generate a mock signature or use test credentials from Razorpay.
- **Endpoint:** `POST /api/credits/purchase/verify`
- **Body:**
  - `razorpay_order_id` (string, required)
  - `razorpay_payment_id` (string, required)
  - `razorpay_signature` (string, required)
- **Request (cURL):**
  ```bash
  curl -X POST http://localhost:8080/api/credits/purchase/verify \
    -H "Authorization: Bearer <YOUR_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{
      "razorpay_order_id": "order_XXXXXX",
      "razorpay_payment_id": "pay_XXXXXX",
      "razorpay_signature": "mock_or_real_signature"
    }'
  ```
- **Expected Response:** `200 OK` with `{ "success": true, "data": { "status": "COMPLETED", ... } }`

---

## Best Tools for Testing

While `cURL` commands are provided above, using an API GUI tool is highly recommended:

1. **Postman / Insomnia:**
   - Create a new collection for `ScribeShade Credits`.
   - Add a global/collection variable `{{baseUrl}}` mapped to `http://localhost:8080`.
   - Setup **Authorization** at the collection level: Select type `Bearer Token` and paste your Clerk token.
2. **VS Code Extensions (REST Client / Thunder Client):**
   - You can create a `.http` file in your workspace to keep all requests easily executable inside your editor.
