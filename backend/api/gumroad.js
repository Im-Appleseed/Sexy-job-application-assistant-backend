const admin = require('firebase-admin');
const axios = require('axios');

// Initialize Firebase Admin SDK
// This uses the secret environment variable we will set up in Vercel.
try {
  if (!admin.apps.length) {
     console.log('[GUMROAD-LOG 1/9] Initializing Firebase Admin SDK...');
     const serviceAccount = JSON.parse(process.env.SEXY_JAA_FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('[GUMROAD-LOG 2/9] Firebase Admin SDK Initialized SUCCESSFULLY.');
  }
} catch (error) {
  console.error('[GUMROAD-LOG ERROR] Firebase Admin Initialization Failed:', error);
}

const db = admin.firestore();

// This is the main serverless function that Vercel will run.
module.exports = async (req, res) => {
   console.log(`[GUMROAD-LOG 3/9] Function invoked with method: ${req.method}`);
  // 1. We only accept POST requests from Gumroad.
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const saleData = req.body;
     console.log('[GUMROAD-LOG 4/9] Received POST request. Full payload:', JSON.stringify(saleData, null, 2));
    const licenseKey = saleData.license_key;
    const userEmail = saleData.email;
    const productName = saleData.product_name; // Keep for logging if needed
    const productId = saleData.product_id;

     if (!userEmail || !productId) {
      console.error('[GUMROAD-LOG ERROR] Webhook missing email or product_id.');
      return res.status(200).send('Acknowledged: Missing email or product_id.');
    }

    console.log(`[GUMROAD-LOG 5/9] Extracted Data: email=${userEmail}, productId=${productId}`);

    // Safety check: a license key is required for verification.
    if (!licenseKey) {
      console.warn('[GUMROAD-LOG WARN] Webhook received without a license key. Cannot verify.');
      return res.status(200).send('Acknowledged: No license key.');
    }

    console.log(`[GUMROAD-LOG 5.1/9] Received webhook for license: ${licenseKey}`);

    // --- START  Gumroad API Verification Call ---
    console.log('[GUMROAD-LOG 5.2/9] Verifying license with Gumroad API...');
    const gumroadResponse = await axios.post('https://api.gumroad.com/v2/licenses/verify', {
      product_id: productId,
      license_key: licenseKey,
      access_token: process.env.GUMROAD_ACCESS_TOKEN // This was the missing piece
    });

    if (!gumroadResponse.data.success || !gumroadResponse.data.purchase) {
      console.error('[GUMROAD-LOG ERROR] Gumroad license verification failed:', gumroadResponse.data.message);
      throw new Error('Invalid license key provided by webhook.');
    }
    // --- END  ---

    console.log(`[GUMROAD-LOG 5.3/9] Successfully verified license for user: ${userEmail}`);

    // 4. Determine the license type and expiration date.
    let licenseType = 'none';
    let expiresAt = null;

    //  Gumroad Product IDs
    const GUMROAD_MONTHLY_ID = "ShurG9dySdzHmVcy-pOEIg==";
    const GUMROAD_LIFETIME_ID = "K5yc5hzns0PdeYgFKyoptQ==";

    if (productId === GUMROAD_LIFETIME_ID) {
      licenseType = 'lifetime';
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 27);
      expiresAt = admin.firestore.Timestamp.fromDate(expiryDate);
    } else if (productId === GUMROAD_MONTHLY_ID) {
      licenseType = 'monthly';
      const expiryDate = new Date();  
      expiryDate.setMonth(expiryDate.getMonth() + 1);
      expiresAt = admin.firestore.Timestamp.fromDate(expiryDate);
    } else {
      console.warn(`[GUMROAD-LOG WARN] Unrecognized product ID: ${productId}. No license granted.`);
      return res.status(200).json({ message: 'Acknowledged: Unrecognized product.' });
    }

    console.log(`[GUMROAD-LOG 6/9] Determined license: type=${licenseType}, expiresAt=${expiresAt.toDate()}`);
    
    // --- START Firestore Logic with UID-based Method ---
    console.log(`[GUMROAD-LOG 7/9] Looking up user in Firebase Auth with email: ${userEmail}`);
    let userRecord;
    try {
        userRecord = await admin.auth().getUserByEmail(userEmail);
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            console.error(`[GUMROAD-LOG ERROR] User with email ${userEmail} has paid but does not have a Firebase Auth account. Cannot grant license.`);
            return res.status(200).json({ message: 'Error: Auth user not found.' });
        }
        throw error; // For other errors, let the main catch block handle it.
    }

    const userId = userRecord.uid;
    console.log(`[GUMROAD-LOG 7.1/9] Found Auth UID: ${userId} for email: ${userEmail}`);

    const licenseData = {
      licenseType: licenseType,
      expiresAt: expiresAt,
      email: userEmail
    };
    
    const userDocRef = db.collection('users').doc(userId);
    console.log(`[GUMROAD-LOG 8/9] Writing license data to Firestore at path: users/${userId}`);
    await userDocRef.set(licenseData, { merge: true });
    

    // 6. ALWAYS send a 200 OK to Gumroad to stop them from sending more pings.
    console.log('[GUMROAD-LOG 9/9] Firestore write operation was successful!');
    return res.status(200).json({ message: 'License granted successfully.' });

  } catch (error) {
    console.error('[GUMROAD-LOG CRITICAL ERROR] The function crashed:', error.message);
    // Even if we fail, tell Gumroad we received the message.
    return res.status(200).json({ message: 'Error acknowledged.' });
  }
};


