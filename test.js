const puppeteer = require('puppeteer');
const RazerScraperService = require('./src/services/RazerScraperService');

async function testPuppeteer() {
  const browser = await puppeteer.launch({
    headless: false,
  });

  const page = await browser.newPage();
  await page.goto(RazerScraperService.LOGIN_URL, { waitUntil: 'networkidle2' });
  await new Promise(resolve => setTimeout(resolve, 15000)); // wait for 10 seconds to manually login
  await page.goto('https://gold.razer.com/global/en/gold/catalog/pubg-mobile-uc-code', { waitUntil: 'networkidle2' });
  // check if out-of-stock or in-stock
  console.log("waiting for in stock selector");
  await page.waitForSelector("input[type='radio'][data-v-498979e2]", { visible: true, timeout: 20000 });

  // select chosen value
  console.log("selecting card value");
  const cards = await page.$$("input[type='radio'][data-v-498979e2]");
  if (cards.length === 0) {
    console.log("No cards available (out of stock)");
    return;
  }
  // select first card for testing
  const chosenCard = cards[0];
  await chosenCard.click();

  // select razer gold as payment method
  console.log("selecting razer gold as payment method");
  const razerGoldPaymentMethod = await page.waitForSelector("div[data-cs-override-id='purchase-paychann-razergoldwallet']", { visible: true, timeout: 20000 });
  razerGoldPaymentMethod.click();

  // click checkout button
  console.log("clicking checkout button");
  const checkoutButton = await page.$("button[data-v-75e3a125][data-v-3ca6ed43]", { visible: true, timeout: 20000 });
  checkoutButton.click();
  console.log("clicked checkout button");

  // now the page will show page with otp input to enter two step verification code
  // we will make bot to click on choose another method button
  // Wait until the OTP modal becomes visible
  // Wait for modal visible
  // Step 1: Wait for the OTP modal to be visible
  await page.waitForFunction(() => {
    const modal = document.querySelector('#purchaseOtpModal');
    if (!modal) return false;
    const style = window.getComputedStyle(modal);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, { polling: 'mutation', timeout: 30000 });

  // Step 2: Wait for any OTP iframe (first one)
  await page.waitForSelector('#purchaseOtpModal iframe[id^="otp-iframe-"]', { visible: true, timeout: 30000 });
  let frameHandle = await page.$('#purchaseOtpModal iframe[id^="otp-iframe-"]');
  let frame = await frameHandle.contentFrame();

  // Step 3: Click “Choose another method” inside iframe
  const chooseAnother = await frame.waitForSelector("button[class*='arrowed']", { visible: true, timeout: 20000 });
  await chooseAnother.click();

  // Step 4: Wait for the new iframe (otp-iframe-4) to appear after clicking
  await page.waitForFunction(() => {
    const newIframe = document.querySelector('#purchaseOtpModal iframe[id^="otp-iframe-"]');
    return newIframe && newIframe.id !== 'otp-iframe-3';
  }, { polling: 'mutation', timeout: 30000 });

  // Step 5: Switch to the new iframe
  frameHandle = await page.$('#purchaseOtpModal iframe[id^="otp-iframe-"]');
  frame = await frameHandle.contentFrame();

  // Step 6: Wait for and click “Backup Codes” button
  // Try clicking the one with “Backup” in its text
  const backupButton = await frame.$$("ul[class*='alt-menu'] button");
  await backupButton[1].click();
}
testPuppeteer();