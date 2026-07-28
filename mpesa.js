// mpesa.js
const axios = require('axios');

// Token cache
let cachedToken = null;
let tokenExpiryTime = null;

/**
 * Get the base URL for the Daraja API based on the current environment.
 */
function getBaseUrl() {
  return process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

/**
 * Generate a timestamp in YYYYMMDDHHmmss format.
 */
function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Generate the M-Pesa password for STK Push.
 * Password = Base64(Shortcode + Passkey + Timestamp)
 */
function generatePassword(timestamp) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const rawPassword = `${shortcode}${passkey}${timestamp}`;
  return Buffer.from(rawPassword).toString('base64');
}

/**
 * Get an OAuth access token from the Daraja API.
 * Uses caching to avoid unnecessary requests.
 */
async function getAccessToken() {
  if (cachedToken && tokenExpiryTime && Date.now() < tokenExpiryTime - 60000) {
    return cachedToken;
  }

  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      'Missing M-Pesa credentials. Set MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET in your .env file.'
    );
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const baseUrl = getBaseUrl();

  try {
    const response = await axios.get(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    cachedToken = response.data.access_token;
    tokenExpiryTime = Date.now() + parseInt(response.data.expires_in, 10) * 1000;
    console.log(`New M-Pesa access token obtained. Expires in ${response.data.expires_in} seconds.`);
    return cachedToken;
  } catch (error) {
    cachedToken = null;
    tokenExpiryTime = null;

    if (error.response) {
      throw new Error(`Daraja OAuth failed: ${error.response.status}`);
    }
    throw new Error('Could not reach Daraja API. Check your internet connection.');
  }
}

/**
 * Initiate an STK Push (Lipa Na M-Pesa Online) payment.
 *
 * @param {string} phoneNumber - Customer phone number (format: 254XXXXXXXXX)
 * @param {number} amount - Amount in KES (minimum 1)
 * @param {string} accountReference - Reference displayed on the prompt (max 12 chars)
 * @param {string} transactionDesc - Description of the transaction
 * @returns {Promise<object>} The Daraja API response
 */
async function initiateSTKPush(phoneNumber, amount, accountReference, transactionDesc) {
  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();
  const password = generatePassword(timestamp);
  const baseUrl = getBaseUrl();

  const shortcode = process.env.MPESA_SHORTCODE;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;

  if (!callbackUrl) {
    throw new Error('MPESA_CALLBACK_URL is not set in your .env file.');
  }

  const payload = {
    BusinessShortCode: parseInt(shortcode, 10),
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: parseInt(amount, 10),
    PartyA: parseInt(phoneNumber, 10),
    PartyB: parseInt(shortcode, 10),
    PhoneNumber: parseInt(phoneNumber, 10),
    CallBackURL: callbackUrl,
    AccountReference: accountReference || 'Payment',
    TransactionDesc: transactionDesc || 'Payment',
  };

  try {
    const response = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    if (error.response) {
      console.error('STK Push error:', error.response.status, error.response.data);
      throw new Error(
        `STK Push failed: ${error.response.data?.errorMessage || error.response.status}`
      );
    }
    throw new Error('Could not reach Daraja API for STK Push.');
  }
}

async function querySTKPushStatus(checkoutRequestId) {
  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();
  const password = generatePassword(timestamp);
  const baseUrl = getBaseUrl();
  const shortcode = process.env.MPESA_SHORTCODE;

  const payload = {
    BusinessShortCode: parseInt(shortcode, 10),
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  try {
    const response = await axios.post(
      `${baseUrl}/mpesa/stkpushquery/v1/query`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(
        `STK Query failed: ${error.response.data?.errorMessage || error.response.status}`
      );
    }
    throw new Error('Could not reach Daraja API for STK Query.');
  }
}

// Update the module.exports to include querySTKPushStatus
module.exports = {
  getAccessToken,
  getBaseUrl,
  getTimestamp,
  generatePassword,
  initiateSTKPush,
  querySTKPushStatus,
};