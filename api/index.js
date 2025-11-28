// /api/index.js (Final and Secure Version with Admin & Reset Logic)

/**
 * SHIB Ads WebApp Backend API
 * Handles all POST requests from the Telegram Mini App frontend.
 * Uses the Supabase REST API for persistence.
 */
const crypto = require('crypto');

// Load environment variables for Supabase connection
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// ⚠️ BOT_TOKEN must be set in Vercel environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;

// ------------------------------------------------------------------
// Fully secured and defined server-side constants
// ------------------------------------------------------------------
const REWARD_PER_AD = 3;
const REFERRAL_COMMISSION_RATE = 0.05;
const DAILY_MAX_ADS = 100; // Max ads limit
const DAILY_MAX_SPINS = 15; // Max spins limit
const RESET_INTERVAL_MS = 6 * 60 * 60 * 1000; // ⬅️ 6 hours in milliseconds
const MIN_TIME_BETWEEN_ACTIONS_MS = 3000; // 3 seconds minimum time between watchAd/spin requests
const ACTION_ID_EXPIRY_MS = 60000; // 60 seconds for Action ID to be valid
const SPIN_SECTORS = [5, 10, 15, 20, 5];

// ------------------------------------------------------------------
// NEW Admin Constant 🔑
// ------------------------------------------------------------------
const ADMIN_USER_ID = '7741750541'; // ⚠️ استبدل هذا بـ Telegram User ID الخاص بك. يجب أن يكون نص (string)
// ------------------------------------------------------------------
// NEW Task Constants
// ------------------------------------------------------------------
const TASK_REWARD = 50;
const TELEGRAM_CHANNEL_USERNAME = '@botbababab'; // يجب أن يكون هذا هو اسم المستخدم للقناة لبدء التحقق


/**
 * Helper function to randomly select a prize from the defined sectors and return its index.
 */
function calculateRandomSpinPrize() {
    const randomIndex = Math.floor(Math.random() * SPIN_SECTORS.length);
    const prize = SPIN_SECTORS[randomIndex];
    return { prize, prizeIndex: randomIndex };
}

// --- Helper Functions ---

function sendSuccess(res, data = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data }));
}

function sendError(res, message, statusCode = 400) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

async function supabaseFetch(tableName, method, body = null, queryParams = '?select=*') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams}`;

  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  };

  const response = await fetch(url, options);

  if (response.ok) {
      const responseText = await response.text();
      try {
          const jsonResponse = JSON.parse(responseText);
          return Array.isArray(jsonResponse) ? jsonResponse : { success: true };
      } catch (e) {
          return { success: true };
      }
  }

  let data;
  try {
      data = await response.json();
  } catch (e) {
      const errorMsg = `Supabase error: ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
  }

  const errorMsg = data.message || `Supabase error: ${response.status} ${response.statusText}`;
  throw new Error(errorMsg);
}

/**
 * Checks if a user is a member (or creator/admin) of a specific Telegram channel.
 */
async function checkChannelMembership(userId, channelUsername) {
    if (!BOT_TOKEN) {
        console.error('BOT_TOKEN is not configured for membership check.');
        return false;
    }
    
    // The chat_id must be in the format @username or -100xxxxxxxxxx
    const chatId = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`; 

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${chatId}&user_id=${userId}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Telegram API error (getChatMember):', errorData.description || response.statusText);
            return false;
        }

        const data = await response.json();
        
        if (!data.ok) {
             console.error('Telegram API error (getChatMember - not ok):', data.description);
             return false;
        }

        const status = data.result.status;
        
        // Accepted statuses are 'member', 'administrator', 'creator'
        const isMember = ['member', 'administrator', 'creator'].includes(status);
        
        return isMember;

    } catch (error) {
        console.error('Network or parsing error during Telegram API call:', error.message);
        return false;
    }
}

/**
 * Helper function to check if the user is the defined Admin.
 */
function isAdminUser(userId) {
    // ⚠️ تأكد أن userId هو سلسلة نصية للمقارنة
    return userId.toString() === ADMIN_USER_ID;
}


/**
 * Limit-Based Reset Logic: Resets counters if the limit was reached AND the interval (6 hours) has passed since.
 * ⚠️ هذا هو التعديل الرئيسي: يعتمد على أعمدة الوصول للحد الأقصى وليس على آخر نشاط عام.
 */
async function resetDailyLimitsIfExpired(userId) {
    const now = Date.now();

    try {
        // 1. Fetch current limits and the time they were reached
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${userId}&select=ads_watched_today,spins_today,ads_limit_reached_at,spins_limit_reached_at`);
        if (!Array.isArray(users) || users.length === 0) {
            return;
        }

        const user = users[0];
        const updatePayload = {};

        // 2. Check Ads Limit Reset
        if (user.ads_limit_reached_at && user.ads_watched_today >= DAILY_MAX_ADS) {
            const adsLimitTime = new Date(user.ads_limit_reached_at).getTime();
            if (now - adsLimitTime > RESET_INTERVAL_MS) {
                // ⚠️ تم مرور 6 ساعات على الوصول للحد الأقصى، يتم إعادة التعيين
                updatePayload.ads_watched_today = 0;
                updatePayload.ads_limit_reached_at = null; // إزالة الوقت لانتهاء فترة القفل
                console.log(`Ads limit reset for user ${userId}.`);
            }
        }

        // 3. Check Spins Limit Reset
        if (user.spins_limit_reached_at && user.spins_today >= DAILY_MAX_SPINS) {
            const spinsLimitTime = new Date(user.spins_limit_reached_at).getTime();
            if (now - spinsLimitTime > RESET_INTERVAL_MS) {
                // ⚠️ تم مرور 6 ساعات على الوصول للحد الأقصى، يتم إعادة التعيين
                updatePayload.spins_today = 0;
                updatePayload.spins_limit_reached_at = null; // إزالة الوقت لانتهاء فترة القفل
                console.log(`Spins limit reset for user ${userId}.`);
            }
        }

        // 4. Perform the database update if any limits were reset
        if (Object.keys(updatePayload).length > 0) {
            await supabaseFetch('users', 'PATCH',
                updatePayload,
                `?id=eq.${userId}`);
        }
    } catch (error) {
        console.error(`Failed to check/reset daily limits for user ${userId}:`, error.message);
    }
}

/**
 * Rate Limiting Check for Ad/Spin Actions
 * ⚠️ تم تعديلها: لم تعد تحدث last_activity، بل فقط تفحص الفارق الزمني الأخير
 */
async function checkRateLimit(userId) {
    try {
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${userId}&select=last_activity`);
        if (!Array.isArray(users) || users.length === 0) {
            return { ok: true };
        }

        const user = users[0];
        // إذا كان last_activity غير موجود، يمكن اعتباره 0 لضمان السماح بالمرور
        const lastActivity = user.last_activity ? new Date(user.last_activity).getTime() : 0; 
        const now = Date.now();
        const timeElapsed = now - lastActivity;

        if (timeElapsed < MIN_TIME_BETWEEN_ACTIONS_MS) {
            const remainingTime = MIN_TIME_BETWEEN_ACTIONS_MS - timeElapsed;
            return {
                ok: false,
                message: `Rate limit exceeded. Please wait ${Math.ceil(remainingTime / 1000)} seconds before the next action.`,
                remainingTime: remainingTime
            };
        }
        // تحديث last_activity سيتم لاحقاً في دوال watchAd/spinResult
        return { ok: true };
    } catch (error) {
        console.error(`Rate limit check failed for user ${userId}:`, error.message);
        return { ok: true };
    }
}

// ------------------------------------------------------------------
// **initData Security Validation Function** (No change)
// ------------------------------------------------------------------
function validateInitData(initData) {
    if (!initData || !BOT_TOKEN) {
        console.warn('Security Check Failed: initData or BOT_TOKEN is missing.');
        return false;
    }

    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHash !== hash) {
        console.warn(`Security Check Failed: Hash mismatch.`);
        return false;
    }

    const authDateParam = urlParams.get('auth_date');
    if (!authDateParam) {
        console.warn('Security Check Failed: auth_date is missing.');
        return false;
    }

    const authDate = parseInt(authDateParam) * 1000;
    const currentTime = Date.now();
    const expirationTime = 1200 * 1000; // 20 minutes limit

    if (currentTime - authDate > expirationTime) {
        console.warn(`Security Check Failed: Data expired.`);
        return false;
    }

    return true;
}

// ------------------------------------------------------------------
// 🔑 Commission Helper Function (No change)
// ------------------------------------------------------------------
/**
 * Processes the commission for the referrer and updates their balance.
 */
async function processCommission(referrerId, refereeId, sourceReward) {
    // 1. Calculate commission
    const commissionAmount = sourceReward * REFERRAL_COMMISSION_RATE; 
    
    if (commissionAmount < 0.000001) { 
        console.log(`Commission too small (${commissionAmount}). Aborted for referee ${refereeId}.`);
        return { ok: false, error: 'Commission amount is effectively zero.' };
    }

    try {
        // 2. Fetch referrer's current balance and status
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${referrerId}&select=balance,is_banned`);
        if (!Array.isArray(users) || users.length === 0 || users[0].is_banned) {
             console.log(`Referrer ${referrerId} not found or banned. Commission aborted.`);
             return { ok: false, error: 'Referrer not found or banned, commission aborted.' };
        }
        
        // 3. Update balance: newBalance will now include the decimal commission
        const newBalance = users[0].balance + commissionAmount;
        
        // 4. Update referrer balance
        await supabaseFetch('users', 'PATCH', { balance: newBalance }, `?id=eq.${referrerId}`); 

        // 5. Add record to commission_history
        await supabaseFetch('commission_history', 'POST', { referrer_id: referrerId, referee_id: refereeId, amount: commissionAmount, source_reward: sourceReward }, '?select=referrer_id');
        
        return { ok: true, new_referrer_balance: newBalance };
    
    } catch (error) {
        console.error('Commission failed:', error.message);
        return { ok: false, error: `Commission failed: ${error.message}` };
    }
}


// ------------------------------------------------------------------
// 🔒 Action ID Security System (No change)
// ------------------------------------------------------------------

/**
 * Generates a strong, random ID for the client to use only once.
 */
function generateStrongId() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * HANDLER: type: "generateActionId"
 * The client requests an action ID before starting a critical action (ad/spin/withdraw/adminAction).
 */
async function handleGenerateActionId(req, res, body) {
    const { user_id, action_type } = body;
    const id = parseInt(user_id);
    
    if (!action_type) {
        return sendError(res, 'Missing action_type.', 400);
    }
    
    // Check if the user already has an unexpired ID for this action type
    try {
        const existingIds = await supabaseFetch('temp_actions', 'GET', null, `?user_id=eq.${id}&action_type=eq.${action_type}&select=action_id,created_at`);
        
        if (Array.isArray(existingIds) && existingIds.length > 0) {
            const lastIdTime = new Date(existingIds[0].created_at).getTime();
            if (Date.now() - lastIdTime < ACTION_ID_EXPIRY_MS) {
                 // If the existing ID is still valid, return it to prevent spamming the table
                return sendSuccess(res, { action_id: existingIds[0].action_id });
            } else {
                 // Clean up expired ID before creating a new one
                 await supabaseFetch('temp_actions', 'DELETE', null, `?user_id=eq.${id}&action_type=eq.${action_type}`);
            }
        }
    } catch(e) {
        console.warn('Error checking existing temp_actions:', e.message);
    }
    
    // Generate and save the new ID
    const newActionId = generateStrongId();
    
    try {
        await supabaseFetch('temp_actions', 'POST',
            { user_id: id, action_id: newActionId, action_type: action_type },
            '?select=action_id');
            
        sendSuccess(res, { action_id: newActionId });
    } catch (error) {
        console.error('Failed to generate and save action ID:', error.message);
        sendError(res, 'Failed to generate security token.', 500);
    }
}


/**
 * Middleware: Checks if the Action ID is valid and then deletes it.
 */
async function validateAndUseActionId(res, userId, actionId, actionType) {
    if (!actionId) {
        sendError(res, 'Missing Server Token (Action ID). Request rejected.', 400);
        return false;
    }
    
    try {
        const query = `?user_id=eq.${userId}&action_id=eq.${actionId}&action_type=eq.${actionType}&select=id,created_at`;
        const records = await supabaseFetch('temp_actions', 'GET', null, query);
        
        if (!Array.isArray(records) || records.length === 0) {
            sendError(res, 'Invalid or previously used Server Token (Action ID).', 409); 
            return false;
        }
        
        const record = records[0];
        const recordTime = new Date(record.created_at).getTime();
        
        // 1. Check Expiration (60 seconds)
        if (Date.now() - recordTime > ACTION_ID_EXPIRY_MS) {
            await supabaseFetch('temp_actions', 'DELETE', null, `?id=eq.${record.id}`);
            sendError(res, 'Server Token (Action ID) expired. Please try again.', 408); 
            return false;
        }

        // 2. Use the token: Delete it to prevent reuse
        await supabaseFetch('temp_actions', 'DELETE', null, `?id=eq.${record.id}`);

        return true;

    } catch (error) {
        console.error(`Error validating Action ID ${actionId}:`, error.message);
        sendError(res, 'Security validation failed.', 500);
        return false;
    }
}

// --- API Handlers ---

/**
 * HANDLER: type: "getUserData"
 * ⚠️ Fix: Now includes admin check and selects new limit columns and task_completed.
 */
async function handleGetUserData(req, res, body) {
    const { user_id } = body;
    if (!user_id) {
        return sendError(res, 'Missing user_id for data fetch.');
    }
    const id = parseInt(user_id);

    try {
        // 1. Check and reset daily limits (if 6 hours passed since limit reached)
        await resetDailyLimitsIfExpired(id);

        // 2. Fetch user data (including new limit columns AND task_completed)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,spins_today,is_banned,ref_by,ads_limit_reached_at,spins_limit_reached_at,task_completed`);

        if (!users || users.length === 0 || users.success) {
            return sendSuccess(res, {
                balance: 0, ads_watched_today: 0, spins_today: 0, referrals_count: 0, withdrawal_history: [], is_banned: false, task_completed: false, is_admin: false
            });
        }

        const userData = users[0];

        // 3. Banned Check - Exit immediately if banned
        if (userData.is_banned) {
             return sendSuccess(res, { is_banned: true, message: "User is banned from accessing the app.", is_admin: false });
        }


        // 4. Fetch referrals count
        const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id`);
        const referralsCount = Array.isArray(referrals) ? referrals.length : 0;

        // 5. Fetch withdrawal history
        const history = await supabaseFetch('withdrawals', 'GET', null, `?user_id=eq.${id}&select=amount,status,created_at&order=created_at.desc`);
        const withdrawalHistory = Array.isArray(history) ? history : [];

        // 6. Update last_activity (only for Rate Limit purposes now)
        await supabaseFetch('users', 'PATCH',
            { last_activity: new Date().toISOString() },
            `?id=eq.${id}&select=id`);
            
        // 7. Check admin status and add it to the response
        const is_admin = isAdminUser(user_id); 

        sendSuccess(res, {
            ...userData,
            is_admin, // ⬅️ إضافة حالة المسؤول
            referrals_count: referralsCount,
            withdrawal_history: withdrawalHistory
        });

    } catch (error) {
        console.error('GetUserData failed:', error.message);
        sendError(res, `Failed to retrieve user data: ${error.message}`, 500);
    }
}


/**
 * 1) type: "register"
 * ⚠️ Fix: Includes task_completed: false for new users.
 */
async function handleRegister(req, res, body) {
  const { user_id, ref_by } = body;
  const id = parseInt(user_id);

  try {
    // 1. Check if user exists
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,is_banned`);

    if (!Array.isArray(users) || users.length === 0) {
      // 2. User does not exist, create new user
      const newUser = {
        id,
        balance: 0,
        ads_watched_today: 0,
        spins_today: 0,
        ref_by: ref_by ? parseInt(ref_by) : null,
        last_activity: new Date().toISOString(), // ⬅️ يبقى هنا للـ Rate Limit فقط
        is_banned: false,
        task_completed: false, // ⬅️ NEW: Default value for the task
        // الأعمدة الجديدة ستحتوي على NULL بشكل افتراضي
      };
      await supabaseFetch('users', 'POST', newUser, '?select=id');
    } else {
        if (users[0].is_banned) {
             return sendError(res, 'User is banned.', 403);
        }
    }

    sendSuccess(res, { message: 'User registered or already exists.' });
  } catch (error) {
    console.error('Registration failed:', error.message);
    sendError(res, `Registration failed: ${error.message}`, 500);
  }
}

/**
 * 2) type: "watchAd"
 * ⚠️ Fix: Updates ads_limit_reached_at when the limit is hit.
 */
async function handleWatchAd(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    const reward = REWARD_PER_AD;

    // 1. Check and Consume Action ID (Security Check)
    if (!await validateAndUseActionId(res, id, action_id, 'watchAd')) return;

    try {
        // 2. Check and reset daily limits (if 6 hours passed since limit reached)
        await resetDailyLimitsIfExpired(id);

        // 3. Fetch current user data 
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,is_banned,ref_by`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const user = users[0];
        const referrerId = user.ref_by; 

        // 4. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 5. Rate Limit Check 
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429); 
        }

        // 6. Check maximum ad limit
        if (user.ads_watched_today >= DAILY_MAX_ADS) {
            return sendError(res, `Daily ad limit (${DAILY_MAX_ADS}) reached.`, 403);
        }

        // 7. Calculate new values
        const newBalance = user.balance + reward;
        const newAdsCount = user.ads_watched_today + 1;
        const updatePayload = {
            balance: newBalance,
            ads_watched_today: newAdsCount,
            last_activity: new Date().toISOString() // ⬅️ تحديث لـ Rate Limit
        };

        // 8. ⚠️ NEW LOGIC: Check if the limit is reached NOW
        if (newAdsCount >= DAILY_MAX_ADS) {
            updatePayload.ads_limit_reached_at = new Date().toISOString();
        }

        // 9. Update user record
        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 10. Commission Call
        if (referrerId) {
            processCommission(referrerId, id, reward).catch(e => {
                console.error(`WatchAd Commission failed silently for referrer ${referrerId}:`, e.message);
            });
        }
          
        // 11. Success
        sendSuccess(res, { new_balance: newBalance, actual_reward: reward, new_ads_count: newAdsCount });

    } catch (error) {
        console.error('WatchAd failed:', error.message);
        sendError(res, `Failed to process ad watch: ${error.message}`, 500);
    }
}

/**
 * 3) type: "commission" (No change)
 */
async function handleCommission(req, res, body) {
    const { referrer_id, referee_id, source_reward } = body;
    const referrerId = parseInt(referrer_id);
    const refereeId = parseInt(referee_id);
    const sourceReward = parseFloat(source_reward) || REWARD_PER_AD; 

    const result = await processCommission(referrerId, refereeId, sourceReward);

    if (result.ok) {
        sendSuccess(res, { new_referrer_balance: result.new_referrer_balance, message: 'Commission successfully processed.' });
    } else {
        console.log(`handleCommission failed: ${result.error}`);
        sendError(res, 'Commission processing failed on the server. ' + result.error, 500); 
    }
}

/**
 * 4) type: "preSpin" (No change)
 */
async function handlePreSpin(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    
    if (!await validateAndUseActionId(res, id, action_id, 'preSpin')) return;

    try {
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        if (users[0].is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        sendSuccess(res, { message: "Pre-spin action secured." });

    } catch (error) {
        console.error('PreSpin failed:', error.message);
        sendError(res, `Failed to secure pre-spin: ${error.message}`, 500);
    }
}


/**
 * 5) type: "spinResult"
 * ⚠️ Fix: Updates spins_limit_reached_at when the limit is hit.
 */
async function handleSpinResult(req, res, body) {
    const { user_id, action_id } = body; 
    const id = parseInt(user_id);
    
    // 1. Check and Consume Action ID (Security Check)
    if (!await validateAndUseActionId(res, id, action_id, 'spinResult')) return; 
    
    // 2. Check and reset daily limits (if 6 hours passed since limit reached)
    await resetDailyLimitsIfExpired(id);

    try {
        // 3. Fetch current user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,spins_today,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const user = users[0];

        // 4. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }
        
        // 5. Rate Limit Check 
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429); 
        }

        // 6. Check maximum spin limit
        if (user.spins_today >= DAILY_MAX_SPINS) {
            return sendError(res, `Daily spin limit (${DAILY_MAX_SPINS}) reached.`, 403);
        }
        
        // --- All checks passed: Process Spin Result ---

        const { prize, prizeIndex } = calculateRandomSpinPrize();
        const newSpinsCount = user.spins_today + 1;
        const newBalance = user.balance + prize;
        
        const updatePayload = {
            balance: newBalance,
            spins_today: newSpinsCount,
            last_activity: new Date().toISOString() // ⬅️ تحديث لـ Rate Limit
        };

        // 7. ⚠️ NEW LOGIC: Check if the limit is reached NOW
        if (newSpinsCount >= DAILY_MAX_SPINS) {
            updatePayload.spins_limit_reached_at = new Date().toISOString();
        }

        // 8. Update user record
        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 9. Save to spin_results
        await supabaseFetch('spin_results', 'POST',
          { user_id: id, prize },
          '?select=user_id');

        // 10. Return the actual, server-calculated prize and index
        sendSuccess(res, { 
            new_balance: newBalance, 
            actual_prize: prize, 
            prize_index: prizeIndex,
            new_spins_count: newSpinsCount
        });

    } catch (error) {
        console.error('Spin result failed:', error.message);
        sendError(res, `Failed to process spin result: ${error.message}`, 500);
    }
}

/**
 * 7) NEW HANDLER: type: "completeTask"
 * ⚠️ Handles the one-time channel join reward task.
 */
async function handleCompleteTask(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    const reward = TASK_REWARD;

    // 1. Check and Consume Action ID (Security Check)
    if (!await validateAndUseActionId(res, id, action_id, 'completeTask')) return;

    try {
        // 2. Fetch current user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,is_banned,task_completed`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const user = users[0];

        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }
        
        // 4. Check if task is already completed
        if (user.task_completed) {
            return sendError(res, 'Task already completed.', 403);
        }
        
        // 5. Check Rate Limit (Good practice for anti-spam)
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429); 
        }

        // 6. 🚨 CRITICAL: Check Channel Membership using Telegram API
        const isMember = await checkChannelMembership(id, TELEGRAM_CHANNEL_USERNAME);

        if (!isMember) {
            return sendError(res, 'User has not joined the required channel.', 400);
        }

        // 7. Process Reward and Update User Data
        const newBalance = user.balance + reward;
        
        const updatePayload = {
            balance: newBalance,
            task_completed: true, // Mark as completed
            last_activity: new Date().toISOString() // Update for Rate Limit
        };

        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);
          
        // 8. Success
        sendSuccess(res, { new_balance: newBalance, actual_reward: reward, message: 'Task completed successfully.' });

    } catch (error) {
        console.error('CompleteTask failed:', error.message);
        sendError(res, `Failed to complete task: ${error.message}`, 500);
    }
}


/**
 * 6) type: "withdraw" (No change, only uses last_activity for rate limit check in checkRateLimit)
 */
async function handleWithdraw(req, res, body) {
    const { user_id, binanceId, amount, action_id } = body;
    const id = parseInt(user_id);
    const withdrawalAmount = parseFloat(amount);
    const MIN_WITHDRAW = 400;

    // 1. Check and Consume Action ID (Security Check)
    if (!await validateAndUseActionId(res, id, action_id, 'withdraw')) return;

    if (withdrawalAmount < MIN_WITHDRAW) {
        return sendError(res, `Minimum withdrawal amount is ${MIN_WITHDRAW} SHIB.`, 400);
    }

    try {
        // 2. Fetch current user balance and banned status
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }

        const user = users[0];

        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }
        
        // 4. Check sufficient balance
        if (user.balance < withdrawalAmount) {
            return sendError(res, 'Insufficient balance.', 400);
        }

        // 5. Calculate new balance
        const newBalance = user.balance - withdrawalAmount;

        // 6. Update user balance
        await supabaseFetch('users', 'PATCH',
          { 
              balance: newBalance,
              last_activity: new Date().toISOString() // ⬅️ تحديث لـ Rate Limit
          },
          `?id=eq.${id}`);

        // 7. Record the withdrawal request
        await supabaseFetch('withdrawals', 'POST',
          { user_id: id, amount: withdrawalAmount, binance_id: binanceId, status: 'pending' },
          '?select=user_id');

        // 8. Success
        sendSuccess(res, { new_balance: newBalance });

    } catch (error) {
        console.error('Withdrawal failed:', error.message);
        sendError(res, `Withdrawal failed: ${error.message}`, 500);
    }
}

// ------------------------------------------------------------------
// NEW: Admin Panel Handlers
// ------------------------------------------------------------------

/**
 * Handles fetching all pending withdrawal requests.
 */
async function handleGetPendingWithdrawals(req, res, body) {
    const { user_id } = body;

    if (!isAdminUser(user_id)) {
        return sendError(res, 'Access Denied: Not an Admin.', 403);
    }

    try {
        // ⚠️ CORRECTION: Use 'id' instead of 'request_id'
        const query = `?status=eq.pending&select=id,user_id,amount,binance_id,created_at&order=created_at.asc`;
        const pending_withdrawals = await supabaseFetch('withdrawals', 'GET', null, query);
        
        if (!Array.isArray(pending_withdrawals)) throw new Error("Failed to fetch data.");

        sendSuccess(res, { pending_withdrawals });
    } catch (error) {
        console.error('Error fetching pending withdrawals:', error.message);
        sendError(res, `Failed to fetch requests: ${error.message}`, 500);
    }
}

/**
 * Handles admin actions: accept, reject, or ban.
 */
async function handleAdminAction(req, res, body) {
    const { user_id, request_id, action, user_to_ban, action_id } = body;

    if (!isAdminUser(user_id)) {
        return sendError(res, 'Access Denied: Not an Admin.', 403);
    }
    
    // 1. Action ID validation
    if (!await validateAndUseActionId(res, user_id, action_id, 'adminAction')) return;

    try {
        if (action === 'ban') {
            if (!user_to_ban) {
                return sendError(res, 'Missing user_to_ban ID.', 400);
            }
            
            // Update user status
            const updatePayload = { is_banned: true };
            await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${user_to_ban}`);

            console.log(`User ${user_to_ban} banned by admin ${user_id}.`);
            return sendSuccess(res, { message: `User ${user_to_ban} banned.` });

        } else if (action === 'accept' || action === 'reject') {
            if (!request_id) {
                return sendError(res, 'Missing request_id for withdrawal action.', 400);
            }

            const newStatus = action === 'accept' ? 'completed' : 'rejected';

            // 2. Get the request details before updating
            // ⚠️ CORRECTION: Use 'id' instead of 'request_id'
            const requests = await supabaseFetch('withdrawals', 'GET', null, `?id=eq.${request_id}&select=user_id,amount,status`);
            const requestData = requests[0];

            if (!requestData) {
                return sendError(res, 'Withdrawal request not found.', 404);
            }
            
            if (requestData.status !== 'pending') {
                 return sendError(res, `Request is already ${requestData.status}.`, 409);
            }

            // 3. Update the withdrawal status
            const updatePayload = { status: newStatus };
            // ⚠️ CORRECTION: Use 'id' instead of 'request_id'
            await supabaseFetch('withdrawals', 'PATCH', updatePayload, `?id=eq.${request_id}`);

            // 4. If rejected, return the balance
            if (action === 'reject') {
                const amountToReturn = requestData.amount;
                const targetUserId = requestData.user_id;

                // Fetch current user balance
                const users = await supabaseFetch('users', 'GET', null, `?id=eq.${targetUserId}&select=balance`);
                const currentBalance = users[0].balance;
                const newBalance = currentBalance + amountToReturn;

                // Update balance
                await supabaseFetch('users', 'PATCH', { balance: newBalance }, `?id=eq.${targetUserId}`);
                
                console.log(`Withdrawal ${request_id} rejected. ${amountToReturn} SHIB returned to user ${targetUserId}.`);
            }
            
            console.log(`Withdrawal ${request_id} set to ${newStatus} by admin ${user_id}.`);
            sendSuccess(res, { message: `Request ${request_id} ${newStatus}.` });

        } else {
            return sendError(res, 'Invalid admin action.', 400);
        }

    } catch (error) {
        console.error('Error handling admin action:', error.message);
        sendError(res, `Admin action failed: ${error.message}`, 500);
    }
}


// --- Main Handler for Vercel/Serverless ---
module.exports = async (req, res) => {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return sendSuccess(res);
  }

  if (req.method !== 'POST') {
    return sendError(res, `Method ${req.method} not allowed. Only POST is supported.`, 405);
  }

  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON payload.'));
        }
      });
      req.on('error', reject);
    });

  } catch (error) {
    return sendError(res, error.message, 400);
  }

  if (!body || !body.type) {
    return sendError(res, 'Missing "type" field in the request body.', 400);
  }

  // ⬅️ initData Security Check (التعديل المصحح والأكثر مرونة)
  
  // قائمة الإجراءات المستثناة من فحص initData الصارم، لأنها محمية بآلية Action ID أو Rate Limit أو لا تحتاج initData أصلاً
  const exceptions = [
      'commission',        // لا تحتاج initData (عملية خادم-خادم)
      'generateActionId',  // محمي بـ Rate Limit
      'watchAd',           // محمي بـ Action ID
      'preSpin',           // محمي بـ Action ID
      'spinResult',        // محمي بـ Action ID
      'withdraw',          // محمي بـ Action ID
      'completeTask',      // محمي بـ Action ID
      'getPendingWithdrawals', // محمي بـ isAdminUser
      'adminAction'        // محمي بـ Action ID و isAdminUser
  ];

  // تطبيق التحقق الصارم لـ initData فقط على طلبات الاتصال الأولية (getUserData و register)
  if (!exceptions.includes(body.type)) {
      if (!body.initData || !validateInitData(body.initData)) {
          return sendError(res, 'Invalid or expired initData. Security check failed.', 401);
      }
  }


  if (!body.user_id && body.type !== 'commission') {
      return sendError(res, 'Missing user_id in the request body.', 400);
  }

  // Route the request based on the 'type' field
  switch (body.type) {
    case 'getUserData':
      await handleGetUserData(req, res, body);
      break;
    case 'register':
      await handleRegister(req, res, body);
      break;
    case 'watchAd':
      await handleWatchAd(req, res, body);
      break;
    case 'commission':
      await handleCommission(req, res, body);
      break;
    case 'preSpin': 
      await handlePreSpin(req, res, body);
      break;
    case 'spinResult': 
      await handleSpinResult(req, res, body);
      break;
    case 'withdraw':
      await handleWithdraw(req, res, body);
      break;
    case 'completeTask': // ⬅️ NEW: Handle the new task logic
      await handleCompleteTask(req, res, body);
      break;
    case 'generateActionId': 
      await handleGenerateActionId(req, res, body);
      break;
    // ⬅️ NEW: Admin Handlers
    case 'getPendingWithdrawals': 
      await handleGetPendingWithdrawals(req, res, body);
      break;
    case 'adminAction': 
      await handleAdminAction(req, res, body);
      break;
    default:
      sendError(res, `Unknown request type: ${body.type}`, 400);
      break;
  }
};