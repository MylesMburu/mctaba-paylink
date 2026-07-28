// server.js
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const { getAccessToken, initiateSTKPush, querySTKPushStatus } = require('./mpesa');

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Helper function for callback metadata
function getCallbackValue(metadata, name) {
  const item = metadata.Item.find((entry) => entry.Name === name);
  return item ? item.Value : null;
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mpesa_configured: !!process.env.MPESA_CONSUMER_KEY && !!process.env.MPESA_CONSUMER_SECRET,
    environment: process.env.MPESA_ENV || 'not set',
  });
});

// Initiate STK Push
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phoneNumber, amount, accountReference, transactionDesc } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }
    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, error: 'Amount must be at least 1 KES' });
    }

    // Format phone number
    let formattedPhone = String(phoneNumber).trim();
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    }
    if (formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.substring(1);
    }

    if (!/^254[17]\d{8}$/.test(formattedPhone)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number. Use format 254XXXXXXXXX',
      });
    }

    // Send STK Push
    const result = await initiateSTKPush(
      formattedPhone,
      amount,
      accountReference || 'PayLink',
      transactionDesc || 'Payment'
    );

    // Store the pending payment in the database
    const payment = await prisma.payment.create({
      data: {
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        phoneNumber: formattedPhone,
        amount: parseFloat(amount),
        accountReference: accountReference || 'PayLink',
        transactionDesc: transactionDesc || 'Payment',
        status: 'pending',
      },
    });

    res.json({
      success: true,
      message: 'STK Push sent. Check your phone for the M-Pesa prompt.',
      data: {
        paymentId: payment.id,
        checkoutRequestId: result.CheckoutRequestID,
      },
    });
  } catch (error) {
    console.error('STK Push error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// M-Pesa callback endpoint
app.post('/api/mpesa/callback', async (req, res) => {
  // Always respond 200 immediately
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const { stkCallback } = req.body.Body;
    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = stkCallback;

    console.log(`Callback received for ${CheckoutRequestID}: ResultCode=${ResultCode}`);

    if (ResultCode === 0) {
      // Payment successful
      const amount = getCallbackValue(CallbackMetadata, 'Amount');
      const receipt = getCallbackValue(CallbackMetadata, 'MpesaReceiptNumber');
      const transactionDate = getCallbackValue(CallbackMetadata, 'TransactionDate');
      const phoneNumber = getCallbackValue(CallbackMetadata, 'PhoneNumber');

      await prisma.payment.update({
        where: { checkoutRequestId: CheckoutRequestID },
        data: {
          status: 'completed',
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          mpesaReceiptNumber: receipt,
          transactionDate: String(transactionDate),
        },
      });

      console.log(`Payment ${CheckoutRequestID} completed. Receipt: ${receipt}`);
    } else {
      // Payment failed or cancelled
      let status = 'failed';
      if (ResultCode === 1032) status = 'cancelled';

      await prisma.payment.update({
        where: { checkoutRequestId: CheckoutRequestID },
        data: {
          status,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
        },
      });

      console.log(`Payment ${CheckoutRequestID} ${status}: ${ResultDesc}`);
    }
  } catch (error) {
    console.error('Error processing callback:', error.message);
    // Do not throw -- we already sent the 200 response
  }
});

// Get payment status
app.get('/api/payments/:id', async (req, res) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: req.params.id },
    });

    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    res.json({ success: true, data: payment });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List all payments
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/mpesa/status/:checkoutRequestId', async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    // First check our database
    const payment = await prisma.payment.findUnique({
      where: { checkoutRequestId },
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found',
      });
    }

    // If the payment is already completed or failed, return the stored result
    if (payment.status === 'completed' || payment.status === 'failed' || payment.status === 'cancelled') {
      return res.json({
        success: true,
        data: {
          status: payment.status,
          resultCode: payment.resultCode,
          resultDesc: payment.resultDesc,
          mpesaReceiptNumber: payment.mpesaReceiptNumber,
          amount: payment.amount,
          phoneNumber: payment.phoneNumber,
        },
      });
    }

    // If still pending, query Daraja for the latest status
    try {
      const queryResult = await querySTKPushStatus(checkoutRequestId);
      const resultCode = parseInt(queryResult.ResultCode, 10);

      if (resultCode === 0) {
        // Payment completed -- update database
        await prisma.payment.update({
          where: { checkoutRequestId },
          data: {
            status: 'completed',
            resultCode: resultCode,
            resultDesc: queryResult.ResultDesc,
          },
        });

        return res.json({
          success: true,
          data: {
            status: 'completed',
            resultCode: resultCode,
            resultDesc: queryResult.ResultDesc,
            amount: payment.amount,
            phoneNumber: payment.phoneNumber,
          },
        });
      } else if (resultCode === 1032) {
        await prisma.payment.update({
          where: { checkoutRequestId },
          data: {
            status: 'cancelled',
            resultCode: resultCode,
            resultDesc: queryResult.ResultDesc,
          },
        });

        return res.json({
          success: true,
          data: { status: 'cancelled', resultCode, resultDesc: queryResult.ResultDesc },
        });
      } else {
        // Other failure
        await prisma.payment.update({
          where: { checkoutRequestId },
          data: {
            status: 'failed',
            resultCode: resultCode,
            resultDesc: queryResult.ResultDesc,
          },
        });

        return res.json({
          success: true,
          data: { status: 'failed', resultCode, resultDesc: queryResult.ResultDesc },
        });
      }
    } catch (queryError) {
      // Query failed -- the payment might still be processing
      return res.json({
        success: true,
        data: {
          status: 'pending',
          message: 'Payment is still being processed. Try again in a few seconds.',
        },
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});