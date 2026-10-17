const { test, expect } = require('@playwright/test');

for (const width of [320, 390, 768, 1440]) {
  test(`explore fits a ${width}px browser`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
    const errors=[];page.on('pageerror', e=>errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('heading', {name:'A little detour. A bigger story.'})).toBeVisible();
    await expect(page.locator('#map .leaflet-tile-loaded').first()).toBeVisible({timeout:30000});
    await expect(page.locator('.discovery-card')).toHaveCount(3);
    // Lazy photographs load when scrolled into view, including in mobile WebKit.
    // Leaflet routinely replaces/cancels tile images during fitBounds; validate
    // loaded tiles separately from the application's static photograph assets.
    const photographs=page.locator('img:not(.leaflet-tile)');
    for(let i=0;i<await photographs.count();i++){
      const photograph=photographs.nth(i);
      await photograph.scrollIntoViewIfNeeded();
      await expect.poll(()=>photograph.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
    }
    await page.evaluate(()=>scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:`test-results/explore-${width}-${test.info().project.name}.png`,fullPage:true});
    await page.getByRole('link',{name:'Our memories'}).click();
    await expect(page.getByRole('heading',{name:'Start a story worth keeping.'})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    expect(errors).toEqual([]);
  });
}

test('phone: route, checkpoint, photo, memory, revisit, summary, and account', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  // Set a comfortably future time for the live pedestrian routing check.
  const time=new Date(Date.now()+75*60000);
  await page.locator('#arrival-input').fill(`${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`);
  await page.locator('#detour-photo-input').setInputFiles('static/images/calton.jpg');
  await expect(page.locator('#detour-photo-preview img')).toBeVisible();
  await page.getByRole('button',{name:'Find my detour'}).click();
  await expect(page.locator('#route-panel')).toBeVisible({timeout:60000});
  await expect(page.locator('.route-stop')).toHaveCount(3);
  await page.getByRole('button',{name:'Let’s start wandering'}).click();
  await expect(page.getByRole('button',{name:'Finish this walk'})).toBeVisible();
  await page.locator('.route-stop').first().click();
  await page.getByRole('button',{name:'I’m here · mark as visited'}).click();
  await expect(page.getByRole('button',{name:'Visited — a memory in the making'})).toBeVisible();
  await page.getByRole('button',{name:'Teach Pip about this place'}).click();
  await expect(page.locator('#companion-mode')).toContainText('Notebook mode');
  await page.locator('#chat-input').fill('I noticed a small blue door beside the old stone wall.');
  await page.locator('#camera-input').setInputFiles('static/images/victoria.jpg');
  await expect(page.locator('#photo-preview img')).toBeVisible();
  await page.getByRole('button',{name:'Save note and send to Pip'}).click();
  await expect(page.locator('.chat-bubble.assistant').last()).toContainText('Saved to our shared notebook');
  await page.getByRole('button',{name:'Close companion'}).click();
  await expect(page.locator('.route-progress-label')).toContainText('1 of 3');
  await page.getByRole('button',{name:'Finish this walk'}).click();
  await expect(page.locator('#summary-dialog')).toBeVisible();
  await expect(page.locator('.summary-notes')).toContainText('small blue door');
  await page.getByRole('button',{name:'Open our notebook'}).click();
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await expect(page.locator('.memory-card img')).toBeVisible();
  await page.reload();
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Revisit this story'}).click();
  await expect(page.locator('.chat-bubble.assistant').first()).toContainText('small blue door');
  await page.getByRole('button',{name:'Close companion'}).click();
  await page.getByRole('link',{name:'Log in',exact:true}).click();
  await page.getByRole('link',{name:'Create an account'}).click();
  await page.getByLabel('Full name').fill('Browser Test Explorer');
  await page.getByLabel('Email address').fill(`browser-${Date.now()}@example.test`);
  await page.getByLabel('Password',{exact:true}).fill('test-browser-password-2026');
  await page.getByRole('button',{name:'Let’s start exploring'}).click();
  await expect(page.getByRole('button',{name:'Your account'})).toBeVisible();
  await page.getByRole('link',{name:'Our memories'}).click();
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await page.screenshot({path:`test-results/phone-memory-${test.info().project.name}.png`,fullPage:true});
  await page.getByRole('link',{name:'My journeys'}).click();
  await expect(page.locator('.journey-card')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('location button reports a usable phone location', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success) { success({ coords: { latitude: 55.9507, longitude: -3.1994, accuracy: 18 } }); }
    }});
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use my current location' }).click();
  await expect(page.locator('#origin-input')).toHaveValue('My current location');
  await expect(page.locator('#location-status')).toContainText('Location found');
});

test('form errors and unknown locations stay actionable', async ({ page }) => {
  await page.goto('/');
  await page.locator('#destination-input').fill('Edinburgh Castle');
  await page.locator('#destination-results').getByRole('button').first().click();
  await page.locator('#arrival-input').fill('00:01');
  await page.getByRole('button',{name:'Find my detour'}).click();
  await expect(page.locator('#trip-error')).toContainText('Choose an arrival time');
  await expect(page.getByRole('button',{name:'Find my detour'})).toBeEnabled();
});
