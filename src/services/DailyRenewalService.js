/**
 * DailyRenewalService
 * 
 * Handles daily renewal of user attempts and subscription expiration checks.
 * Runs automatically at 12:00 AM every day.
 */

const databaseService = require('./DatabaseService');
const authService = require('./AuthorizationService');

class DailyRenewalService {
  constructor() {
    this.isRunning = false;
    this.scheduledJob = null;
  }

  /**
   * Start the daily renewal scheduler
   */
  start() {
    console.log('📅 Starting Daily Renewal Service...');

    // Schedule first run at next 12:00 AM
    this.scheduleNextRun();

    console.log('✅ Daily Renewal Service started');
  }

  /**
   * Schedule the next run at 12:00 AM
   */
  scheduleNextRun() {
    const now = new Date();
    const next12AM = new Date();

    // Set to 12:00 AM
    next12AM.setHours(0, 0, 0, 0);

    // If it's already past 12:00 AM today, schedule for tomorrow
    if (now >= next12AM) {
      next12AM.setDate(next12AM.getDate() + 1);
    }

    const timeUntilNext = next12AM.getTime() - now.getTime();

    console.log(`⏰ Next daily renewal scheduled for: ${next12AM.toLocaleString()}`);
    console.log(`   (in ${Math.round(timeUntilNext / 1000 / 60 / 60)} hours)`);

    // Clear existing timeout if any
    if (this.scheduledJob) {
      clearTimeout(this.scheduledJob);
    }

    // Schedule the job
    this.scheduledJob = setTimeout(() => {
      this.runDailyRenewal();
    }, timeUntilNext);
  }

  /**
   * Run the daily renewal process
   */
  async runDailyRenewal() {
    if (this.isRunning) {
      console.log('⚠️ Daily renewal already running, skipping...');
      return;
    }

    this.isRunning = true;
    console.log('\n' + '='.repeat(60));
    console.log('🌅 DAILY RENEWAL STARTED - ' + new Date().toLocaleString());
    console.log('='.repeat(60));

    try {
      await databaseService.connect();

      // Step 1: Get all users
      console.log('\n📋 Step 1: Fetching all users...');
      const allUsers = await this.getAllUsers();
      console.log(`   Found ${allUsers.length} users`);

      let renewedCount = 0;
      let expiredCount = 0;
      let errorCount = 0;

      // Step 2: Process each user
      console.log('\n🔄 Step 2: Processing users...');

      for (const user of allUsers) {
        try {
          const now = new Date();
          const expiresAt = user.SubscriptionExpiresAt ? new Date(user.SubscriptionExpiresAt) : null;
          const hasExpired = expiresAt && expiresAt < now;

          // Check if subscription expired
          if (hasExpired && user.SubscriptionType !== 'free') {
            console.log(`   ❌ User ${user.telegram_user_id}: Subscription EXPIRED, downgrading to FREE`);

            await databaseService.updateUserSubscription(user.id, {
              subscriptionType: 'free',
              allowedAttempts: 0
            });

            expiredCount++;
          } else {
            // Renew attempts based on plan
            const newAttempts = this.getAttemptsForPlan(user.SubscriptionType);

            await databaseService.updateUserAttempts(user.id, newAttempts);

            console.log(`   ✅ User ${user.telegram_user_id}: Attempts renewed to ${newAttempts} (${user.SubscriptionType})`);
            renewedCount++;
          }
        } catch (err) {
          console.error(`   ❌ Error processing user ${user.telegram_user_id}:`, err.message);
          errorCount++;
        }
      }

      // Step 3: Clear all authorization cache (force fresh data)
      console.log('\n🗑️ Step 3: Clearing authorization cache...');
      authService.invalidateAllCache();

      // Summary
      console.log('\n' + '='.repeat(60));
      console.log('📊 DAILY RENEWAL SUMMARY');
      console.log('='.repeat(60));
      console.log(`Total Users:        ${allUsers.length}`);
      console.log(`Attempts Renewed:   ${renewedCount}`);
      console.log(`Subscriptions Expired: ${expiredCount}`);
      console.log(`Errors:             ${errorCount}`);
      console.log('='.repeat(60) + '\n');

    } catch (err) {
      console.error('❌ Daily renewal failed:', err);
    } finally {
      this.isRunning = false;

      // Schedule next run (24 hours from now)
      this.scheduleNextRun();
    }
  }

  /**
   * Get all users from database
   * @returns {Promise<Array>} Array of users
   */
  async getAllUsers() {
    try {
      const result = await databaseService.pool.request()
        .query('SELECT * FROM user_accounts');

      return result.recordset;
    } catch (err) {
      console.error('Error fetching all users:', err);
      return [];
    }
  }

  /**
   * Get attempts quota for a subscription plan
   * @param {string} plan - Subscription plan type
   * @returns {number} Number of attempts
   */
  getAttemptsForPlan(plan) {
    const planAttempts = {
      'free': 0,        // Free plan: 0 attempts
      'pro': 10,        // Pro plan: 10 attempts per day
      'gold': 20,       // Gold plan: 20 attempts per day
      'vip': 30        // VIP plan: 30 attempts per day
    };

    return planAttempts[plan.toLowerCase()] || 0;
  }

  /**
   * Manually trigger renewal (for testing or manual runs)
   */
  async manualRenewal() {
    console.log('🔧 Manual renewal triggered');
    await this.runDailyRenewal();
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.scheduledJob) {
      clearTimeout(this.scheduledJob);
      this.scheduledJob = null;
    }
    console.log('🛑 Daily Renewal Service stopped');
  }
}

// Export singleton instance
module.exports = new DailyRenewalService();
