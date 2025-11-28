// /api/index.js (Final and Secure Version with Dynamic Tasks)

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
// NEW Task Constants
// ------------------------------------------------------------------
// هذا يجب أن يتطابق مع 'task_type' في جدول المهام لتمييز مهام القنوات
const TASK_TYPE_CHANNEL_JOIN = 'channel_join'; 

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
          // Adjust for Supabase specific responses (e.g., single object on POST/PATCH vs array on GET)
          if (method === 'POST' || method === 'PATCH') {
              return Array.isArray(jsonResponse) ? jsonResponse : [jsonResponse];
          }
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
 * Limit-Based Reset Logic: Resets counters if the limit was reached AND the interval (6 hours) has passed since.
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
                // تم مرور 6 ساعات على الوصول للحد الأقصى، يتم إعادة التعيين
                updatePayload.ads_watched_today = 0;
                updatePayload.ads_limit_reached_at = null; 
                console.log(`Ads limit reset for user ${userId}.`);
            }
        }

        // 3. Check Spins Limit Reset
        if (user.spins_limit_reached_at && user.spins_today >= DAILY_MAX_SPINS) {
            const spinsLimitTime = new Date(user.spins_limit_reached_at).getTime();
            if (now - spinsLimitTime > RESET_INTERVAL_MS) {
                // تم مرور 6 ساعات على الوصول للحد الأقصى، يتم إعادة التعيين
                updatePayload.spins_today = 0;
                updatePayload.spins_limit_reached_at = null; 
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
        return { ok: false, error: error.message };
    }
}

// ------------------------------------------------------------------
// **Action ID Middleware** (No change)
// ------------------------------------------------------------------
/**
 * 0) type: "requestActionId" 
 * Generates and saves a unique action ID (security token) for the next request.
 */
async function handleRequestActionId(req, res, body) {
    const { user_id, action_type } = body;
    const id = parseInt(user_id);
    if (!action_type) {
        return sendError(res, 'Missing action_type.', 400);
    }
    
    try {
        // Check if user is banned
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=is_banned`);
        if (!Array.isArray(users) || users.length === 0 || users[0].is_banned) {
            return sendError(res, 'User not found or is banned.', 403);
        }

        const actionId = crypto.randomBytes(32).toString('hex');
        
        await supabaseFetch('temp_actions', 'POST', {
            user_id: id,
            action_id: actionId,
            action_type: action_type,
            created_at: new Date().toISOString()
        }, '?select=user_id');

        sendSuccess(res, { action_id: actionId });

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

        // 2. Delete the used ID
        await supabaseFetch('temp_actions', 'DELETE', null, `?id=eq.${record.id}`);

        return true;

    } catch (error) {
        console.error('Action ID validation failed:', error.message);
        sendError(res, 'Internal Server Error during token validation.', 500);
        return false;
    }
}

// ------------------------------------------------------------------
// **Core Handlers**
// ------------------------------------------------------------------

/**
 * 1) type: "getUserData" (No change)
 */
async function handleGetUserData(req, res, body) {
    const { user_id } = body;
    const id = parseInt(user_id);
    
    try {
        // Reset limits if needed (must happen before fetching data)
        await resetDailyLimitsIfExpired(id);

        // Fetch user data, including last_activity for rate limit check
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,balance,ads_watched_today,spins_today,is_banned,last_activity`);

        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not registered.', 404);
        }

        const userData = users[0];
        if (userData.is_banned) {
            return sendSuccess(res, { ...userData, referrals_count: 0, withdrawal_history: [] });
        }
        
        // Fetch referrals count
        const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id`);
        const referralsCount = Array.isArray(referrals) ? referrals.length : 0;

        // Fetch withdrawal history
        const withdrawalRecords = await supabaseFetch('withdrawals', 'GET', null, `?user_id=eq.${id}&select=amount,binance_id,status,created_at&order=created_at.desc`);
        const withdrawalHistory = Array.isArray(withdrawalRecords) ? withdrawalRecords : [];

        // Update last_activity for non-action requests (to prevent session expiry/timeout for TWA)
        // Ensure last_activity is updated (but this doesn't reset the 3-second action timer, which is checked by checkRateLimit)
        await supabaseFetch('users', 'PATCH', { last_activity: new Date().toISOString() }, `?id=eq.${id}&select=id`);

        sendSuccess(res, { ...userData, referrals_count: referralsCount, withdrawal_history: withdrawalHistory });

    } catch (error) {
        console.error('GetUserData failed:', error.message);
        sendError(res, `Failed to retrieve user data: ${error.message}`, 500);
    }
}

/**
 * 2) type: "register" (No change)
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
                last_activity: new Date().toISOString(), 
                is_banned: false
                // task_completed field removed as it's now dynamic in user_tasks
            };
            const [createdUser] = await supabaseFetch('users', 'POST', newUser);
            
            return sendSuccess(res, { message: 'User registered successfully.', user: createdUser });
        }
        
        return sendSuccess(res, { message: 'User already registered.' });

    } catch (error) {
        console.error('Register failed:', error.message);
        sendError(res, `Failed to register user: ${error.message}`, 500);
    }
}


/**
 * 3) type: "watchAd" (No change)
 */
async function handleWatchAd(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    const actionType = 'watchAdSequence'; // Use the sequence ID type

    // 1. Action ID validation (security check)
    if (!await validateAndUseActionId(res, id, action_id, actionType)) {
        return;
    }

    try {
        // 2. Fetch user data (lock row for balance update if supported)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,balance,ads_watched_today,ref_by,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }

        const user = users[0];
        const referrerId = user.ref_by;
        const reward = REWARD_PER_AD;

        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 4. Rate Limit Check (already done implicitly by Action ID, but good to keep the explicit check logic)
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429);
        }

        // 5. Check maximum ad limit
        if (user.ads_watched_today >= DAILY_MAX_ADS) {
            return sendError(res, `Daily ad limit (${DAILY_MAX_ADS}) reached.`, 403);
        }

        // --- All checks passed: Process Ad Watch ---
        
        // 6. Calculate new balance and counters
        const newBalance = user.balance + reward;
        const newAdsCount = user.ads_watched_today + 1;
        const updatePayload = {
            balance: newBalance,
            ads_watched_today: newAdsCount,
            last_activity: new Date().toISOString() // ⬅️ تحديث لـ Rate Limit
        };

        // 7. NEW LOGIC: Check if the limit is reached NOW
        if (newAdsCount >= DAILY_MAX_ADS) {
            updatePayload.ads_limit_reached_at = new Date().toISOString();
        }

        // 8. Update user record
        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 9. Commission Call
        if (referrerId) {
            processCommission(referrerId, id, reward).catch(e => {
                console.error(`WatchAd Commission failed silently for referrer ${referrerId}:`, e.message);
            });
        }

        // 10. Success
        sendSuccess(res, {
            new_balance: newBalance,
            actual_reward: reward,
            new_ads_count: newAdsCount
        });

    } catch (error) {
        console.error('WatchAd failed:', error.message);
        sendError(res, `Failed to process ad watch: ${error.message}`, 500);
    }
}

/**
 * 4) type: "preSpin" (No change)
 */
async function handlePreSpin(req, res, body) {
     const { user_id, action_id } = body;
     const id = parseInt(user_id);
     const actionType = 'preSpin'; // Action ID type

     // 1. Action ID validation (security check)
     if (!await validateAndUseActionId(res, id, action_id, actionType)) {
        return;
     }

     try {
         // 2. Fetch user data (light check)
         const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=is_banned,spins_today`);
         if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
         }

         const user = users[0];

         // 3. Banned Check
         if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
         }

         // 4. Check maximum spin limit (final check before ad)
         if (user.spins_today >= DAILY_MAX_SPINS) {
            return sendError(res, `Daily spin limit (${DAILY_MAX_SPINS}) reached.`, 403);
         }

         // 5. Success
         sendSuccess(res, { message: 'Pre-spin checks passed. Ready for ad and spin.' });

     } catch (error) {
         console.error('PreSpin failed:', error.message);
         sendError(res, `Failed to process pre-spin: ${error.message}`, 500);
     }
}

/**
 * 5) type: "spinResult" (No change)
 */
async function handleSpinResult(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    const actionType = 'spinResult'; // Action ID type
    
    // 1. Action ID validation (security check)
    if (!await validateAndUseActionId(res, id, action_id, actionType)) {
        return;
    }

    try {
        // 2. Fetch user data 
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,balance,spins_today,ref_by,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }

        const user = users[0];
        const referrerId = user.ref_by;

        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 4. Rate Limit Check 
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            return sendError(res, rateLimitResult.message, 429);
        }

        // 5. Check maximum spin limit
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

        // 6. NEW LOGIC: Check if the limit is reached NOW
        if (newSpinsCount >= DAILY_MAX_SPINS) {
            updatePayload.spins_limit_reached_at = new Date().toISOString();
        }

        // 7. Update user record
        await supabaseFetch('users', 'PATCH', updatePayload, `?id=eq.${id}`);

        // 8. Commission Call
        if (referrerId) {
            processCommission(referrerId, id, prize).catch(e => {
                 console.error(`Spin Commission failed silently for referrer ${referrerId}:`, e.message);
            });
        }

        // 9. Success
        sendSuccess(res, { 
            new_balance: newBalance,
            prize: prize,
            prizeIndex: prizeIndex,
            new_spins_count: newSpinsCount
        });

    } catch (error) {
        console.error('SpinResult failed:', error.message);
        sendError(res, `Failed to process spin result: ${error.message}`, 500);
    }
}

/**
 * 6) type: "withdraw" (No change)
 */
async function handleWithdraw(req, res, body) {
    const { user_id, binanceId, amount, action_id } = body;
    const id = parseInt(user_id);
    const withdrawAmount = parseInt(amount);

    // 1. Action ID validation (security check)
    if (!await validateAndUseActionId(res, id, action_id, 'withdraw')) {
        return;
    }

    if (isNaN(withdrawAmount) || withdrawAmount < 400 || !binanceId) {
        return sendError(res, 'Invalid amount or Binance ID.', 400);
    }

    try {
        // 2. Fetch user data 
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,balance,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        const user = users[0];

        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 4. Balance Check
        if (user.balance < withdrawAmount) {
            return sendError(res, 'Insufficient balance.', 403);
        }
        
        // 5. Rate Limit Check
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
             return sendError(res, rateLimitResult.message, 429);
        }

        // 6. Deduct balance and record withdrawal request
        const newBalance = user.balance - withdrawAmount;
        
        // Update user balance (atomically preferred, but using PATCH here)
        await supabaseFetch('users', 'PATCH', { 
            balance: newBalance,
            last_activity: new Date().toISOString() 
        }, `?id=eq.${id}`); 

        // Insert withdrawal record
        await supabaseFetch('withdrawals', 'POST', {
            user_id: id,
            amount: withdrawAmount,
            binance_id: binanceId,
            status: 'pending' 
        });

        // 7. Success
        sendSuccess(res, { new_balance: newBalance, message: 'Withdrawal request submitted.' });

    } catch (error) {
        console.error('Withdraw failed:', error.message);
        sendError(res, `Failed to process withdrawal: ${error.message}`, 500);
    }
}

/* =================================================== */
/* ===== NEW DYNAMIC TASK HANDLERS ===== */
/* =================================================== */

/**
 * 7) type: "getTasks"
 * Retrieves active tasks, filters out completed ones, and enforces the "single channel" rule.
 */
async function handleGetTasks(req, res, body) {
    const { user_id } = body;
    const id = parseInt(user_id);

    try {
        // 1. جلب المهام النشطة من الجدول (يفترض وجود عمود 'is_active' وعمود 'priority' و 'task_type' في جدول tasks)
        const allTasks = await supabaseFetch('tasks', 'GET', null, `?is_active=eq.true&select=id,task_name,task_link,reward_shib,required_completions,current_completions,task_type&order=priority.asc`);

        if (!Array.isArray(allTasks) || allTasks.length === 0) {
            return sendSuccess(res, { tasks: [] }); 
        }

        // 2. جلب المهام التي أتمها المستخدم (يفترض جدول user_tasks يحتوي task_id, user_id)
        const completedTasks = await supabaseFetch('user_tasks', 'GET', null, `?user_id=eq.${id}&select=task_id`);
        const completedTaskIds = new Set(Array.isArray(completedTasks) ? completedTasks.map(t => t.task_id) : []);
        
        // 3. تطبيق قاعدة: "مهمة قناة واحدة ظاهرة" وتصفية المهام المكتملة/الممتلئة
        let finalTasks = [];
        let channelTaskAdded = false;

        for (const task of allTasks) {
            const taskId = task.id;

            // تخطي المهام التي أتمها المستخدم مسبقاً
            if (completedTaskIds.has(taskId)) {
                continue;
            }

            // تخطي المهام التي تجاوزت العدد المطلوب من المستخدمين (ممتلئة)
            if (task.current_completions >= task.required_completions) {
                 continue;
            }
            
            // تطبيق قاعدة "مهمة قناة واحدة ظاهرة"
            if (task.task_type === TASK_TYPE_CHANNEL_JOIN) {
                if (!channelTaskAdded) {
                    finalTasks.push(task);
                    channelTaskAdded = true; // تم إضافة أول مهمة قناة، لن يتم إضافة غيرها
                }
            } else {
                // إضافة أنواع المهام الأخرى (غير الانضمام لقناة)
                finalTasks.push(task);
            }
        }

        return sendSuccess(res, { tasks: finalTasks });

    } catch (error) {
        console.error('handleGetTasks failed:', error.message);
        sendError(res, `Failed to retrieve tasks: ${error.message}`, 500);
    }
}

/**
 * 8) type: "completeTask" 
 * Checks membership for channel join tasks and updates user/task data.
 */
async function handleCompleteTask(req, res, body) {
    const { user_id, task_id, action_id } = body;
    const id = parseInt(user_id);
    const taskId = parseInt(task_id);

    // 1. Action ID validation (security check)
    if (!await validateAndUseActionId(res, id, action_id, 'completeTask')) {
        return;
    }

    try {
        // 2. Fetch User Data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,balance,ref_by,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        const user = users[0];

        // 3. Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 4. Check if task already completed by user
        const completedCheck = await supabaseFetch('user_tasks', 'GET', null, `?user_id=eq.${id}&task_id=eq.${taskId}`);
        if (Array.isArray(completedCheck) && completedCheck.length > 0) {
            return sendError(res, 'Task already completed.', 409);
        }

        // 5. Fetch Task Details (Use 'current_completions' and 'required_completions' for locking)
        const tasks = await supabaseFetch('tasks', 'GET', null, `?id=eq.${taskId}&select=task_name,task_link,reward_shib,task_type,required_completions,current_completions,is_active`);
        if (!Array.isArray(tasks) || tasks.length === 0 || !tasks[0].is_active) {
            return sendError(res, 'Task not found or is inactive.', 404);
        }
        const task = tasks[0];

        // 6. Check if task is full
        if (task.current_completions >= task.required_completions) {
            return sendError(res, 'Task limit reached.', 403);
        }
        
        // 7. Perform Type-Specific Check (Example: Channel Join)
        if (task.task_type === TASK_TYPE_CHANNEL_JOIN) {
            const channelUsername = task.task_link.split('/').pop().replace('@', ''); // استخراج اسم المستخدم من الرابط
            const isMember = await checkChannelMembership(id, channelUsername);

            if (!isMember) {
                return sendError(res, 'User has not joined the required channel.', 400);
            }
        }
        
        // 8. Process Reward and Update User Data (Transactionally Preferred)
        const reward = task.reward_shib;
        const newBalance = user.balance + reward;
        
        // a. Mark Task as Completed for the User
        await supabaseFetch('user_tasks', 'POST', { user_id: id, task_id: taskId });
        
        // b. Update User Balance
        const userUpdatePayload = { 
            balance: newBalance, 
            last_activity: new Date().toISOString() // Update for Rate Limit
        };
        await supabaseFetch('users', 'PATCH', userUpdatePayload, `?id=eq.${id}`); 

        // c. Increment Task Completion Count (Use current_completions + 1)
        const newCompletions = task.current_completions + 1;
        await supabaseFetch('tasks', 'PATCH', { current_completions: newCompletions }, `?id=eq.${taskId}`);

        // d. Process Commission (if applicable)
        if (user.ref_by) {
            processCommission(user.ref_by, id, reward).catch(e => {
                console.error(`Task Commission failed silently for referrer ${user.ref_by}:`, e.message);
            });
        }

        // 9. Success
        sendSuccess(res, { new_balance: newBalance, actual_reward: reward, message: 'Task completed successfully.' });

    } catch (error) {
        console.error('CompleteTask failed:', error.message);
        sendError(res, `Failed to complete task: ${error.message}`, 500);
    }
}


/**
 * 9) type: "commission" (No change)
 */
async function handleCommission(req, res, body) {
    const { referrer_id, referee_id, source_reward } = body;
    const referrerId = parseInt(referrer_id);
    const refereeId = parseInt(referee_id);
    const sourceReward = parseFloat(source_reward);
    
    // Safety check: only allow commission requests from the server itself
    // In a production setup, this endpoint should be secured by a server-to-server token
    if (referrerId === refereeId) {
        return sendError(res, 'Self-commission is not allowed.', 400);
    }

    const result = await processCommission(referrerId, refereeId, sourceReward);

    if (result.ok) {
        sendSuccess(res, { message: 'Commission processed successfully.' });
    } else {
        // Log the failure but return 200/ok if it's a non-critical error like 'referrer not found'
        console.warn(`Commission processing failed for referee ${refereeId}: ${result.error}`);
        sendSuccess(res, { message: 'Commission check finished (may have failed due to referrer status).' });
    }
}


// ------------------------------------------------------------------
// **Main Router**
// ------------------------------------------------------------------

module.exports = async (req, res) => {
  let body;
  try {
    body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk.toString(); });
        req.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON payload.')); }
        });
        req.on('error', reject);
    });

  } catch (error) {
    return sendError(res, error.message, 400);
  }

  if (!body || !body.type) {
    return sendError(res, 'Missing "type" field in the request body.', 400);
  }

  // ⬅️ initData Security Check (Skip for 'commission' endpoint)
  if (body.type !== 'commission' && (!body.initData || !validateInitData(body.initData))) {
      return sendError(res, 'Invalid or expired initData. Security check failed.', 401);
  }

  if (!body.user_id && body.type !== 'commission' && body.type !== 'requestActionId') {
      return sendError(res, 'Missing user_id in the request body.', 400);
  }

  // Route the request based on the 'type' field
  switch (body.type) {
    case 'requestActionId':
        await handleRequestActionId(req, res, body);
        break;
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
    case 'completeTask': // ⬅️ الآن ديناميكي
      await handleCompleteTask(req, res, body);
      break;
    case 'getTasks': // ⬅️ جلب المهام الديناميكية
      await handleGetTasks(req, res, body);
      break;
    
    default:
      return sendError(res, `Unknown request type: ${body.type}`, 400);
  }
};