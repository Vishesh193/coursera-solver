// Developed & Owned by Vishesh Arora
// Global State
let globalState = {
    isRunning: false,
    currentAction: null,
    statusMessage: "Ready",
    progress: { current: 0, total: 0, message: "" },
    logs: []
};

// Helper to log to popup
function log(msg) {
    console.log("[FcukCoursera]", msg);
    globalState.logs.push(msg);
    if (globalState.logs.length > 100) globalState.logs.shift();
    chrome.runtime.sendMessage({ action: "log", data: msg }).catch(() => {});
}

function updateStatus(msg) {
    globalState.statusMessage = msg;
    chrome.runtime.sendMessage({ action: "status", data: msg }).catch(() => {});
}

function updateProgress(current, total, message) {
    globalState.progress = { current, total, message };
    chrome.runtime.sendMessage({ 
        action: "progress_update", 
        data: { current, total, message } 
    }).catch(() => {});
}

// Main Logic
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "ping") {
        sendResponse({ pong: true });
        return;
    }

    if (request.action === "get_status") {
        sendResponse(globalState);
        return;
    }

    if (request.action === "start_skipping") {
        if (globalState.isRunning) {
            sendResponse({ status: "already_running" });
            return;
        }
        globalState.isRunning = true;
        globalState.currentAction = "skipping";
        startSkippingProcess().finally(() => { globalState.isRunning = false; });
        sendResponse({ status: "started" });
    }
    if (request.action === "start_reading_completion") {
        if (globalState.isRunning) {
            sendResponse({ status: "already_running" });
            return;
        }
        globalState.isRunning = true;
        globalState.currentAction = "reading";
        startReadingCompletionProcess().finally(() => { globalState.isRunning = false; });
        sendResponse({ status: "started" });
    }
    if (request.action === "start_quiz_solver") {
        if (globalState.isRunning) {
            sendResponse({ status: "already_running" });
            return;
        }
        globalState.isRunning = true;
        globalState.currentAction = "quiz";
        startQuizSolverProcess(request.apiKeys).finally(() => { globalState.isRunning = false; });
        sendResponse({ status: "started" });
    }
    if (request.action === "start_complete_course") {
        if (globalState.isRunning) {
            sendResponse({ status: "already_running" });
            return;
        }
        globalState.isRunning = true;
        globalState.currentAction = "complete";
        startCompleteCourseProcess(request.apiKeys).finally(() => { globalState.isRunning = false; });
        sendResponse({ status: "started" });
    }
    if (request.action === "start_discussions") {
        if (globalState.isRunning) {
            sendResponse({ status: "already_running" });
            return;
        }
        globalState.isRunning = true;
        globalState.currentAction = "discussion";
        startDiscussionProcess().finally(() => { globalState.isRunning = false; });
        sendResponse({ status: "started" });
    }

    // Popup asks for the list of discussion items (popup will drive navigation)
    if (request.action === "get_discussion_items") {
        getCourseData().then(({ userId, courseId, courseSlug, allItems }) => {
            let discussionItems = allItems.filter(item => {
                const t1 = (item.typeName || '').toLowerCase();
                const t2 = (item.contentSummary?.typeName || '').toLowerCase();
                const name = (item.name || '').toLowerCase();
                const slug = (item.slug || '').toLowerCase();
                const hasPromptDef = Boolean(item.contentSummary?.definition?.discussionPromptId);
                return t1.includes('discussion') || t2.includes('discussion') ||
                       t1.includes('prompt') || t2.includes('prompt') ||
                       hasPromptDef ||
                       name.includes('discussion') || name.includes('observation') || name.includes('prompt') ||
                       slug.includes('discussion') || slug.includes('observation') || slug.includes('prompt');
            });
            sendResponse({ items: discussionItems.map(i => ({ id: i.id, name: i.name })), courseSlug });
        }).catch(e => {
            sendResponse({ error: e.message });
        });
        return true; // async
    }

    // Popup navigated to a page and asks us to type "yes" and click Reply
    if (request.action === "type_and_submit_reply") {
        typeAndSubmitReply().then(success => {
            sendResponse({ success });
        }).catch(() => sendResponse({ success: false }));
        return true; // async
    }
});

async function startCompleteCourseProcess(apiKeys) {
    try {
        const { userId, courseId, courseSlug, allItems } = await getCourseData();
        
        log(`Starting Course Completion. Found ${allItems.length} items.`);
        updateProgress(0, allItems.length, "Starting...");

        let completedCount = 0;
        
        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];
            const progressMsg = `[${i + 1}/${allItems.length}] ${item.typeName}: ${item.name}`;
            updateStatus(progressMsg);
            updateProgress(i, allItems.length, item.name);
            
            try {
                let result = false;
                
                if (item.typeName === 'lecture') {
                    result = await completeSingleVideo(userId, courseId, courseSlug, item.id);
                    if (result) log(`[Video Completed] ${item.name}`);
                } 
                else if (item.typeName === 'supplement' || item.typeName === 'article' || item.typeName === 'resource') {
                    result = await completeSingleReading(userId, courseId, courseSlug, item.id);
                    if (result) log(`[Reading Completed] ${item.name}`);
                }
                else {
                    log(`[Processing Assessment/Assignment/Lab] ${item.name} (${item.typeName})`);
                    await processQuizItem(userId, courseId, item, apiKeys);
                    result = true;
                }

                if (result) {
                    completedCount++;
                    // Rate limit delay - Reduced to 100ms
                    await new Promise(r => setTimeout(r, 100));
                }

            } catch (e) {
                log(`[Error] ${item.name}: ${e.message}`);
            }
        }

        updateProgress(allItems.length, allItems.length, "Done!");
        updateStatus(`Done! Processed ${allItems.length} items.`);
        chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});

    } catch (e) {
        log("Error: " + e.message);
        updateStatus("Error occurred. Check logs.");
    }
}

async function startSkippingProcess() {
    try {
        const { userId, courseId, courseSlug, allItems } = await getCourseData();
        
        log(`Queued ${allItems.length} items for checking...`);
        updateProgress(0, allItems.length, "Starting...");

        // 4. Iterate and Complete
        let completedCount = 0;
        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];
            updateStatus(`[${i + 1}/${allItems.length}] ${item.moduleName}: ${item.name}`);
            updateProgress(i, allItems.length, item.name);
            
            try {
                const result = await completeSingleVideo(userId, courseId, courseSlug, item.id);
                if (result) {
                    log(`[Video Completed] ${item.name} (${item.moduleName})`);
                    completedCount++;
                    // Reduced delay after a successful video completion to speed up processing
                    await new Promise(r => setTimeout(r, 50));
                } else {
                    // It wasn't a video, or failed silently
                    // log(`[Skipped] ${item.name} (Not a video)`);
                    // Short delay to not hammer API
                    await new Promise(r => setTimeout(r, 10));
                }
            } catch (e) {
                log(`[Error] ${item.name}: ${e.message}`);
            }
        }

        updateProgress(allItems.length, allItems.length, "Done!");
        updateStatus(`Done! Completed ${completedCount} videos.`);
        chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});

    } catch (e) {
        log("Error: " + e.message);
        updateStatus("Error occurred. Check logs.");
    }
}

/**
 * Core logic adapted from your script to complete a single video by Item ID
 * Returns true if it was a video and completed successfully, false otherwise.
 */
async function completeSingleVideo(userId, courseId, courseSlug, itemId) {
    // A. Get Video Metadata (Tracking ID & Duration)
    let timeCommitment = 1800000; // Hardcoded to 30 minutes
    let trackingId = null;

    try {
        const videoMetadataUrl = `https://www.coursera.org/api/onDemandLectureVideos.v1/${courseId}~${itemId}?includes=video&fields=disableSkippingForward,startMs,endMs`;
        const metaResp = await fetch(videoMetadataUrl, {credentials: "include"});
        
        // If 404 or other error, it's likely not a video (e.g. reading, quiz)
        if (!metaResp.ok) return false;

        const metaData = await metaResp.json();
        const videoElement = metaData.linked?.["onDemandVideos.v1"]?.[0];
        
        if (videoElement) {
            trackingId = videoElement.id;
        } else {
            return false; // Not a video
        }
    } catch (e) {
        return false; // Failed to fetch metadata, assume not a video
    }

    if (!trackingId) {
        return false;
    }

    // B. Execute Completion Sequence
    const apiUrlBase = `https://www.coursera.org/api/opencourse.v1/user/${userId}/course/${courseSlug}/item/${itemId}/lecture/videoEvents/`;
    const progressUrl = `https://www.coursera.org/api/onDemandVideoProgresses.v1/${userId}~${courseId}~${trackingId}`;

    const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
    const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
    
    const headers = {
        'Content-Type': 'application/json',
        'x-csrf3-token': csrfToken,
        'x-coursera-application': 'ondemand',
        'x-requested-with': 'XMLHttpRequest',
    };
    const payload = JSON.stringify({ contentRequestBody: {} });

    // 1. Play
    await fetch(apiUrlBase + 'play?autoEnroll=false', {
        method: 'POST', headers: headers, body: payload, credentials: 'include'
    });

    // 2. Update Progress
    const progressPayload = JSON.stringify({
        videoProgressId: `${userId}~${courseId}~${trackingId}`,
        viewedUpTo: timeCommitment 
    });
    await fetch(progressUrl, {
        method: 'PUT', headers: headers, body: progressPayload, credentials: 'include'
    });

    // Wait a bit for server validation - Reduced to 100ms
    await new Promise(resolve => setTimeout(resolve, 100));

    // 3. End
    const endResp = await fetch(apiUrlBase + 'ended?autoEnroll=false', {
        method: 'POST', headers: headers, body: payload, credentials: 'include'
    });

    if (endResp.status !== 200 && endResp.status !== 204) {
        throw new Error(`End event failed: ${endResp.status}`);
    }

    return true;
}

async function getCourseData() {
    log("Initializing...");
    
    // 1. Get Course Slug from URL
    const urlParts = window.location.pathname.split('/').filter(p => p);
    const learnIndex = urlParts.indexOf('learn');
    if (learnIndex === -1 || urlParts.length <= learnIndex + 1) {
        throw new Error("Could not find course slug in URL. Go to course home.");
    }
    const courseSlug = urlParts[learnIndex + 1];
    log(`Course Slug: ${courseSlug}`);

    // 2. Get User ID and Course ID
    let userId, courseId;
    try {
        const userResp = await fetch("https://www.coursera.org/api/adminUserPermissions.v1?q=my", {credentials: "include"});
        const userData = await userResp.json();
        userId = userData.elements?.[0]?.id;

        const courseResp = await fetch(`https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseSlug}&includes=tracks`, {credentials: "include"});
        const courseData = await courseResp.json();
        courseId = courseData.elements?.[0]?.id;
        
        if (!userId || !courseId) throw new Error("Missing IDs");
        log(`User ID: ${userId}, Course ID: ${courseId}`);
    } catch (e) {
        throw new Error("Error fetching User/Course IDs: " + e.message);
    }

    // 3. Fetch Course Syllabus
    log("Fetching course syllabus...");
    let allItems = [];
    try {
        // Try namespaced fields to force return of specific properties
        const params = new URLSearchParams({
            q: 'slug',
            slug: courseSlug,
            includes: 'modules,lessons,items',
            fields: 'onDemandCourseMaterialItems.v2(name,typeName,contentSummary)'
        });
        const syllabusUrl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?${params.toString()}`;
        log(`Syllabus URL: ${syllabusUrl}`);
        
        const syllabusResp = await fetch(syllabusUrl, {credentials: "include"});
        const syllabusData = await syllabusResp.json();
        
        if (!syllabusData.linked) {
             throw new Error("'linked' property missing.");
        }

        const items = syllabusData.linked["onDemandCourseMaterialItems.v2"] || [];
        const modules = syllabusData.linked["onDemandCourseMaterialModules.v1"] || [];
        
        const moduleMap = {};
        modules.forEach(m => { moduleMap[m.id] = m.name; });

        log(`Total items found: ${items.length} across ${modules.length} modules.`);
        
        if (items.length > 0) {
           log("First Item Keys: " + Object.keys(items[0]).join(", "));
           // log("First Item Sample: " + JSON.stringify(items[0]));
        }

        allItems = items.map(item => ({
            id: item.id,
            name: item.name,
            slug: item.slug,
            typeName: item.typeName || item.contentSummary?.typeName,
            contentSummary: item.contentSummary,
            moduleId: item.moduleId,
            moduleName: moduleMap[item.moduleId] || "Unknown Module"
        }));

    } catch (e) {
        throw new Error("Error fetching syllabus: " + e.message);
    }

    return { userId, courseId, courseSlug, allItems };
}

async function startReadingCompletionProcess() {
    try {
        const { userId, courseId, courseSlug, allItems } = await getCourseData();
        
        // Filter for readings if typeName is available
        let readingItems = allItems.filter(item => item.typeName === 'supplement');
        
        if (readingItems.length === 0) {
            log("No explicit 'supplement' types found. Checking all items...");
            readingItems = allItems;
        } else {
            log(`Found ${readingItems.length} readings.`);
        }

        updateProgress(0, readingItems.length, "Starting...");

        let completedCount = 0;
        for (let i = 0; i < readingItems.length; i++) {
            const item = readingItems[i];
            updateStatus(`[${i + 1}/${readingItems.length}] Checking: ${item.name}`);
            updateProgress(i, readingItems.length, item.name);
            
            try {
                const result = await completeSingleReading(userId, courseId, courseSlug, item.id);
                if (result) {
                    log(`[Reading Completed] ${item.name}`);
                    completedCount++;
                    // Small delay to avoid rate limits - Reduced to 50ms
                    await new Promise(r => setTimeout(r, 50));
                }
            } catch (e) {
                log(`[Error] ${item.name}: ${e.message}`);
            }
        }

        updateProgress(readingItems.length, readingItems.length, "Done!");
        updateStatus(`Done! Completed ${completedCount} readings.`);
        chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});

    } catch (e) {
        log("Error: " + e.message);
        updateStatus("Error occurred. Check logs.");
    }
}

async function startDiscussionProcess() {
    try {
        log("Starting Discussion Process...");

        let userId, courseId, courseSlug, allItems;
        try {
            const data = await getCourseData();
            userId = data.userId;
            courseId = data.courseId;
            courseSlug = data.courseSlug;
            allItems = data.allItems;
        } catch(e) {
            log(`Error fetching course data: ${e.message}`);
            updateStatus("Error: Could not fetch course data.");
            chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});
            return;
        }

        // Filter discussion prompt candidates
        let discussionItems = allItems.filter(item => {
            const t1 = (item.typeName || '').toLowerCase();
            const t2 = (item.contentSummary?.typeName || '').toLowerCase();
            const name = (item.name || '').toLowerCase();
            const slug = (item.slug || '').toLowerCase();
            const hasPromptDef = Boolean(item.contentSummary?.definition?.discussionPromptId);
            return t1.includes('discussion') || t2.includes('discussion') ||
                   t1.includes('prompt') || t2.includes('prompt') ||
                   hasPromptDef ||
                   name.includes('discussion') || name.includes('observation') || name.includes('prompt') ||
                   slug.includes('discussion') || slug.includes('observation') || slug.includes('prompt');
        });

        if (discussionItems.length === 0) {
            log("No discussion types found.");
            updateStatus("No discussion items found.");
            chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});
            return;
        }

        log(`Found ${discussionItems.length} discussion items. Navigating to each to submit reply...`);
        updateProgress(0, discussionItems.length, "Starting...");

        let completedCount = 0;
        for (let i = 0; i < discussionItems.length; i++) {
            const item = discussionItems[i];
            updateStatus(`[${i + 1}/${discussionItems.length}] Navigating to: ${item.name}`);
            updateProgress(i, discussionItems.length, item.name);

            try {
                // Navigate to the discussion prompt page
                const itemUrl = `https://www.coursera.org/learn/${courseSlug}/item/${item.id}`;
                log(`Navigating to: ${item.name}`);
                window.location.href = itemUrl;

                // Wait for the page to fully load (4 seconds)
                await new Promise(r => setTimeout(r, 4000));

                // Type "yes" and click Reply using React-compatible method
                const typed = await typeAndSubmitReply();
                if (typed) {
                    log(`[Submitted Reply] ${item.name}`);
                    completedCount++;
                } else {
                    log(`[No form found] ${item.name} - trying API fallback`);
                    await markDiscussionComplete(userId, courseId, item);
                }

                // Wait before next item
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                log(`[Error] ${item.name}: ${e.message}`);
            }
        }

        updateProgress(discussionItems.length, discussionItems.length, "Done!");
        updateStatus(`Done! Submitted ${completedCount}/${discussionItems.length} discussion replies.`);
        chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});

    } catch (e) {
        log("Error: " + e.message);
        updateStatus("Error occurred. Check logs.");
    }
}

async function typeAndSubmitReply() {
    log("Processing discussion page...");

    // Scroll down to ensure discussion components render and lazy-load
    window.scrollTo(0, 400);
    await new Promise(r => setTimeout(r, 600));

    let domResult = false;
    try {
        domResult = await fillAndSubmitDiscussionPromptDOM();
    } catch(e) {
        log(`DOM fill note: ${e.message}`);
    }

    // Always run API completion as backup to ensure Coursera registers completion
    try {
        const itemId = window.location.href.split('/item/')[1]?.split('?')[0]?.split('#')[0];
        if (itemId) {
            const { userId, courseId } = await getCourseData();
            if (userId && courseId) {
                await markDiscussionComplete(userId, courseId, { id: itemId });
                log(`[API Marked Completed] Item ${itemId}`);
            }
        }
    } catch(e) {
        log(`API completion backup note: ${e.message}`);
    }

    return domResult;
}

async function completeSingleReading(userId, courseId, courseSlug, itemId) {
    try {
        // 1. Check if it is a supplement (reading)
        const checkUrl = `https://www.coursera.org/api/onDemandSupplements.v1/${courseId}~${itemId}`;
        const checkResp = await fetch(checkUrl, { method: 'GET', credentials: 'include' });
        
        if (!checkResp.ok) {
            return false; 
        }

        const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
        const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
        
        const headers = {
            'Content-Type': 'application/json',
            'x-csrf3-token': csrfToken,
            'x-coursera-application': 'ondemand',
            'x-requested-with': 'XMLHttpRequest',
        };

        const completionId = `${userId}~${courseId}~${itemId}`;
        const resourceUrl = `https://www.coursera.org/api/onDemandSupplementCompletions.v1/${completionId}`;
        const collectionUrl = `https://www.coursera.org/api/onDemandSupplementCompletions.v1`;

        // Strategy 1: POST to collection with userId as Number
        // This is the most common pattern for creating a new completion record
        try {
            const body = JSON.stringify({
                courseId: courseId,
                itemId: itemId,
                userId: Number(userId)
            });
            const res = await fetch(collectionUrl, { method: 'POST', headers, body, credentials: 'include' });
            if (res.ok) return true;
            // log(`Strategy 1 failed: ${res.status}`);
        } catch(e) {}

        // Strategy 2: PUT to resource with composite ID and userId as Number
        try {
            const body = JSON.stringify({
                id: completionId,
                courseId: courseId,
                itemId: itemId,
                userId: Number(userId)
            });
            const res = await fetch(resourceUrl, { method: 'PUT', headers, body, credentials: 'include' });
            if (res.ok) return true;
            // log(`Strategy 2 failed: ${res.status}`);
        } catch(e) {}

        // Strategy 3: PUT to resource with just ID (minimal update)
        try {
            const body = JSON.stringify({
                id: completionId
            });
            const res = await fetch(resourceUrl, { method: 'PUT', headers, body, credentials: 'include' });
            if (res.ok) return true;
        } catch(e) {}

        return false;
    } catch (e) {
        log(`Error completing reading: ${e.message}`);
        return false;
    }
}

async function startQuizSolverProcess(apiKeys) {
    try {
        const { userId, courseId, courseSlug, allItems } = await getCourseData();
        
        // Log all found types to help debug
        const uniqueTypes = [...new Set(allItems.map(item => item.typeName))];
        log(`Found item types: ${uniqueTypes.map(t => t || 'undefined').join(', ')}`);

        // Filter out pure videos & readings, process all quizzes, practice assessments, graded assignments, labs, etc.
        const nonMediaItems = allItems.filter(item => !['lecture', 'supplement', 'article', 'resource'].includes(item.typeName));
        
        log(`Found ${nonMediaItems.length} quizzes, graded assignments, practice assessments & labs.`);
        
        for (let i = 0; i < nonMediaItems.length; i++) {
            const item = nonMediaItems[i];
            updateStatus(`[${i + 1}/${nonMediaItems.length}] ${item.typeName}: ${item.name}`);
            updateProgress(i, nonMediaItems.length, item.name);
            
            log(`[Processing Item] ${item.name} (${item.typeName}) - ID: ${item.id}`);

            try {
                await processQuizItem(userId, courseId, item, apiKeys);
            } catch (err) {
                log(`Failed to process item ${item.name}: ${err.message}`);
            }
        }

        updateProgress(nonMediaItems.length, nonMediaItems.length, "Done!");
        updateStatus(`Done! Processed ${nonMediaItems.length} items.`);
        chrome.runtime.sendMessage({ action: "finished" }).catch(() => {});

    } catch (e) {
        log("Error: " + e.message);
        updateStatus("Error occurred. Check logs.");
    }
}

async function processQuizItem(userId, courseId, item, apiKeys) {
    log(`Processing ${item.name} (${item.typeName})...`);
    
    if (item.contentSummary) {
        log(`Content Summary: ${JSON.stringify(item.contentSummary)}`);
    }

    // Discussion Prompts
    if (['discussionPrompt', 'discussion', 'discussionForum', 'discussionPromptQuestion'].includes(item.typeName)) {
        try {
            await processDiscussionPrompt(userId, courseId, item, apiKeys);
            return;
        } catch (e) {
            log(`Discussion prompt processing error for ${item.name}: ${e.message}`);
        }
    }

    // Step A: Try Exam Session API first (for exam/gradedQuiz types)
    let processed = false;
    const examTypes = ['exam', 'gradedQuiz'];
    if (examTypes.includes(item.typeName)) {
        try {
            await processExamItem(userId, courseId, item, apiKeys);
            processed = true;
        } catch (e) {
            log(`Exam session method failed for ${item.name}: ${e.message}`);
        }
    }

    // Step B: Try GraphQL Submission API (works for quizzes, practice assessments, graded assignments, peer reviews, widgets)
    if (!processed) {
        try {
            await processUngradedAssignment(userId, courseId, item, apiKeys);
            processed = true;
        } catch (e) {
            log(`GraphQL method failed for ${item.name}: ${e.message}`);
        }
    }

    // Step C: Try lab/item/discussion completion API (for labs, workspaces, programming assignments, widgets, or fallback)
    try {
        await completeLabOrGenericItem(userId, courseId, item);
    } catch (e) {
        log(`Completion API failed for ${item.name}: ${e.message}`);
    }
}

async function fillAndSubmitDiscussionPromptDOM() {
    log("Scanning DOM for Discussion Prompt editor & submit button...");
    
    // Strictly select real text inputs, textareas, and contenteditable containers (EXCLUDE a, button, etc.)
    const selectors = [
        'textarea',
        'div[contenteditable="true"]',
        '[role="textbox"]',
        '[data-slate-editor="true"]',
        '.DraftEditor-root [contenteditable="true"]',
        '.rc-FormTextarea',
        '.cml-editor [contenteditable="true"]',
        '.c-discussion-prompt-response-form textarea',
        'textarea[placeholder*="response"]',
        'textarea[placeholder*="Response"]',
        'textarea[placeholder*="Type"]',
        'div[contenteditable="true"][placeholder*="response"]',
        'div[contenteditable="true"][placeholder*="Type"]'
    ];
    
    const candidateNodes = Array.from(document.querySelectorAll(selectors.join(', ')));
    const inputElements = candidateNodes.filter(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' || tag === 'button' || (tag === 'input' && el.type !== 'text' && el.type !== 'textarea')) {
            return false;
        }
        return tag === 'textarea' || el.isContentEditable || el.getAttribute('role') === 'textbox';
    });

    log(`Found ${inputElements.length} valid text editor elements on page.`);

    let targetEditor = null;
    for (const el of inputElements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            targetEditor = el;
            break;
        }
    }

    if (!targetEditor) {
        log("No visible editor found by selector, checking contenteditable elements...");
        targetEditor = Array.from(document.querySelectorAll('*')).find(el => {
            const tag = el.tagName.toLowerCase();
            return el.isContentEditable && tag !== 'a' && tag !== 'button';
        });
    }

    if (!targetEditor) {
        log("No active Discussion Prompt text editor found on current page.");
        return false;
    }

    log(`Targeting editor element (${targetEditor.tagName})`);
    targetEditor.focus();

    try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(targetEditor);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, 'yes');
    } catch(e) {}

    if ('value' in targetEditor) {
        targetEditor.value = "yes";
    }
    targetEditor.innerText = "yes";
    targetEditor.textContent = "yes";
    targetEditor.innerHTML = "<p>yes</p>";

    const events = [
        new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'yes' }),
        new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'yes' }),
        new Event('input', { bubbles: true }),
        new Event('change', { bubbles: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 's', code: 'KeyS' }),
        new KeyboardEvent('keyup', { bubbles: true, key: 's', code: 'KeyS' }),
        new FocusEvent('blur', { bubbles: true })
    ];
    events.forEach(evt => targetEditor.dispatchEvent(evt));

    log('Typed "yes" into active Discussion Prompt editor.');

    await new Promise(r => setTimeout(r, 400));

    // Find submit button in editor container parent hierarchy
    let container = targetEditor.parentElement;
    let submitBtn = null;

    for (let depth = 0; depth < 8 && container; depth++) {
        const buttons = Array.from(container.querySelectorAll('button, input[type="submit"]'));
        submitBtn = buttons.find(b => {
            const rect = b.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            const text = (b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || '').toLowerCase().trim();
            return text.includes('reply') || text.includes('submit') || text.includes('post') || text.includes('save');
        });
        if (submitBtn) break;
        container = container.parentElement;
    }

    if (!submitBtn) {
        const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        submitBtn = allButtons.find(b => {
            const rect = b.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            const text = (b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || '').toLowerCase().trim();
            return text === 'reply' || text === 'submit' || text === 'post' || text === 'save' || text.includes('submit reply') || text.includes('post reply');
        });
    }

    if (submitBtn) {
        log(`Found Submit button: "${submitBtn.innerText || submitBtn.textContent || submitBtn.value}"`);
        submitBtn.disabled = false;
        submitBtn.removeAttribute('disabled');
        submitBtn.setAttribute('aria-disabled', 'false');
        
        submitBtn.focus();
        submitBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        submitBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        submitBtn.click();
        log("Clicked Submit button on page!");
        return true;
    } else {
        log("No visible Submit button found in editor container.");
    }
    return true;
}

async function processDiscussionPrompt(userId, courseId, item, apiKeys) {
    // This is kept for compatibility with processQuizItem
    await markDiscussionComplete(userId, courseId, item);
}

async function markDiscussionComplete(userId, courseId, item) {
    const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
    const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
    const headers = {
        'Content-Type': 'application/json',
        'x-csrf3-token': csrfToken,
        'x-coursera-application': 'ondemand',
        'x-requested-with': 'XMLHttpRequest',
    };

    // Extract discussionPromptId from item definition if available
    const discussionPromptId = item.contentSummary?.definition?.discussionPromptId || item.id;
    const completionId = `${userId}~${courseId}~${item.id}`;

    // Step 1: Submit "yes" post to discussion prompt
    // Coursera requires a post/reply to exist before marking as complete
    const postPayloads = [
        {
            courseId: courseId,
            itemId: item.id,
            content: { typeName: 'cml', definition: { value: '<co-content><p>yes</p></co-content>' } }
        },
        {
            courseId: courseId,
            itemId: item.id,
            content: { cmlValue: '<co-content><p>yes</p></co-content>' }
        },
        {
            courseId: courseId,
            itemId: item.id,
            discussionPromptId: discussionPromptId,
            content: { cml: { value: '<co-content><p>yes</p></co-content>' } }
        }
    ];

    let postOk = false;
    for (const payload of postPayloads) {
        try {
            const res = await fetch('https://www.coursera.org/api/onDemandDiscussionPromptPosts.v1', {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                credentials: 'include'
            });
            log(`  [Post Reply] → ${res.status}`);
            if (res.ok || res.status === 409) { postOk = true; break; }
            if (res.status === 429) {
                log(`  Rate limited — waiting 5s...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        } catch(e) {}
    }

    // Step 2: Mark item complete via completion endpoint
    const completionPayloads = [
        {
            url: 'https://www.coursera.org/api/onDemandDiscussionPromptCompletions.v1',
            method: 'POST',
            body: JSON.stringify({ courseId, itemId: item.id, userId: Number(userId) })
        },
        {
            url: `https://www.coursera.org/api/onDemandDiscussionPromptCompletions.v1/${completionId}`,
            method: 'PUT',
            body: JSON.stringify({ id: completionId, courseId, itemId: item.id, userId: Number(userId) })
        },
        {
            url: 'https://www.coursera.org/api/onDemandItemCompletions.v1',
            method: 'POST',
            body: JSON.stringify({ courseId, itemId: item.id, userId: Number(userId) })
        }
    ];

    for (const cp of completionPayloads) {
        try {
            const res = await fetch(cp.url, {
                method: cp.method,
                headers,
                body: cp.body,
                credentials: 'include'
            });
            log(`  [${cp.url.split('/').pop().split('?')[0]}] → ${res.status}`);
            if (res.ok || res.status === 409) return; // done
            if (res.status === 429) await new Promise(r => setTimeout(r, 5000));
        } catch(e) {}
    }
}

async function completeLabOrGenericItem(userId, courseId, item) {
    const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
    const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
    
    const headers = {
        'Content-Type': 'application/json',
        'x-csrf3-token': csrfToken,
        'x-coursera-application': 'ondemand',
        'x-requested-with': 'XMLHttpRequest',
    };

    const completionId = `${userId}~${courseId}~${item.id}`;
    const endpoints = [
        'onDemandDiscussionPromptCompletions.v1',
        'onDemandSupplementCompletions.v1',
        'onDemandItemCompletions.v1',
        'onDemandAppCompletions.v1'
    ];

    for (const endpoint of endpoints) {
        try {
            const collectionUrl = `https://www.coursera.org/api/${endpoint}`;
            const resourceUrl = `https://www.coursera.org/api/${endpoint}/${completionId}`;

            const postBody = JSON.stringify({
                courseId: courseId,
                itemId: item.id,
                userId: Number(userId)
            });
            const postRes = await fetch(collectionUrl, { method: 'POST', headers, body: postBody, credentials: 'include' });
            if (postRes.ok) {
                log(`[Lab/Item Completed via ${endpoint}] ${item.name}`);
                return true;
            }

            const putBody = JSON.stringify({
                id: completionId,
                courseId: courseId,
                itemId: item.id,
                userId: Number(userId)
            });
            const putRes = await fetch(resourceUrl, { method: 'PUT', headers, body: putBody, credentials: 'include' });
            if (putRes.ok) {
                log(`[Lab/Item Completed via ${endpoint}] ${item.name}`);
                return true;
            }
        } catch (e) {}
    }
    return false;
}

async function processUngradedAssignment(userId, courseId, item, apiKeys) {
    log(`Attempting to process Ungraded Assignment: ${item.name}`);

    // Strategy: Use GraphQL Submission_StartAttempt
    // Based on user logs, this is the correct way to start these assignments
    const graphqlUrl = 'https://www.coursera.org/graphql-gateway?opname=Submission_StartAttempt';
    
    const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
    const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
    
    const headers = {
        'Content-Type': 'application/json',
        'x-csrf3-token': csrfToken,
        'x-coursera-application': 'ondemand',
        'x-requested-with': 'XMLHttpRequest',
    };

    const query = `mutation Submission_StartAttempt($courseId: ID!, $itemId: ID!) {
      Submission_StartAttempt(input: {courseId: $courseId, itemId: $itemId}) {
        ... on Submission_StartAttemptSuccess {
          submissionState {
            assignment {
              id
            }
          }
        }
        ... on Submission_StartAttemptFailure {
          errors {
            errorCode
            message
          }
        }
      }
    }`;

    try {
        log("Sending GraphQL StartAttempt...");
        const body = JSON.stringify({
            operationName: "Submission_StartAttempt",
            query: query,
            variables: {
                courseId: courseId,
                itemId: item.id
            }
        });

        const resp = await fetch(graphqlUrl, {
            method: 'POST',
            headers: headers,
            body: body,
            credentials: 'include'
        });

        if (!resp.ok) {
            log(`GraphQL Request Failed: ${resp.status}`);
            return;
        }

        const data = await resp.json();
        
        // Check for errors in the top-level response
        if (data.errors) {
            log(`GraphQL Errors: ${JSON.stringify(data.errors)}`);
            return;
        }

        const result = data.data?.Submission_StartAttempt;
        
        // Always attempt processGraphQLSession to solve and submit questions using Mistral AI
        log("Attempting GraphQL Session processing...");
        await processGraphQLSession(courseId, item.id, headers, apiKeys);

    } catch (e) {
        log(`Error in GraphQL Start: ${e.message}`);
    }
}

async function processGraphQLSession(courseId, itemId, headers, apiKeys) {
    log("Attempting to fetch questions via GraphQL...");
    
    const graphqlUrl = 'https://www.coursera.org/graphql-gateway?opname=QueryState';
    
    // The massive query string provided by the user
    const query = `fragment CheckboxQuestion on Submission_CheckboxQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    options {
      ...Option
      __typename
    }
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  checkboxResponse: response {
    chosen
    __typename
  }
  __typename
}

fragment CheckboxReflectQuestion on Submission_CheckboxReflectQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    options {
      ...Option
      __typename
    }
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  checkboxReflectResponse: response {
    chosen
    __typename
  }
  __typename
}

fragment CodeExpressionQuestion on Submission_CodeExpressionQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    codeLanguage
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    replEvaluatorId
    starterCode {
      code
      __typename
    }
    __typename
  }
  codeExpressionResponse: response {
    answer {
      code
      __typename
    }
    __typename
  }
  __typename
}

fragment FileUploadQuestion on Submission_FileUploadQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    plagiarismCheckStatus
    allowedFiles
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  fileUploadResponse: response {
    caption
    fileUrl
    title
    __typename
  }
  __typename
}

fragment MathQuestion on Submission_MathQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  mathResponse: response {
    answer
    __typename
  }
  __typename
}

fragment MultipleChoiceQuestion on Submission_MultipleChoiceQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    options {
      ...Option
      __typename
    }
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  multipleChoiceResponse: response {
    chosen
    __typename
  }
  __typename
}

fragment MultipleChoiceReflectQuestion on Submission_MultipleChoiceReflectQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    options {
      ...Option
      __typename
    }
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  multipleChoiceReflectResponse: response {
    chosen
    __typename
  }
  __typename
}

fragment MultipleChoiceFillableBlank on Submission_MultipleChoiceFillableBlank {
  fillableBlankId: id
  answerOptions {
    ...Option
    __typename
  }
  __typename
}

fragment MultipleChoiceFillableBlankResponse on Submission_MultipleChoiceFillableBlankResponse {
  responseId: id
  optionId
  __typename
}

fragment MultipleFillableBlanksResponse on Submission_MultipleFillableBlanksQuestionResponse {
  responses {
    ...MultipleChoiceFillableBlankResponse
    __typename
  }
  __typename
}

fragment MultipleFillableBlanksQuestion on Submission_MultipleFillableBlanksQuestion {
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    fillableBlanks {
      ...MultipleChoiceFillableBlank
      __typename
    }
    __typename
  }
  multipleFillableBlanksResponse: response {
    ...MultipleFillableBlanksResponse
    __typename
  }
  gradeSettings {
    maxScore
    __typename
  }
  __typename
}

fragment NumericQuestion on Submission_NumericQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  numericResponse: response {
    answer
    __typename
  }
  __typename
}

fragment OffPlatformQuestion on Submission_OffPlatformQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  __typename
}

fragment PlainTextQuestion on Submission_PlainTextQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  plainTextResponse: response {
    plainText
    __typename
  }
  __typename
}

fragment RegexQuestion on Submission_RegexQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  regexResponse: response {
    answer
    __typename
  }
  __typename
}

fragment RichTextQuestion on Submission_RichTextQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    plagiarismCheckStatus
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  richTextResponse: response {
    richText {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  __typename
}

fragment TextExactMatchQuestion on Submission_TextExactMatchQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  textExactMatchResponse: response {
    answer
    __typename
  }
  __typename
}

fragment TextReflectQuestion on Submission_TextReflectQuestion {
  gradeSettings {
    maxScore
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  textReflectResponse: response {
    answer
    __typename
  }
  __typename
}

fragment UrlQuestion on Submission_UrlQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    plagiarismCheckStatus
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    __typename
  }
  urlResponse: response {
    caption
    title
    url
    __typename
  }
  __typename
}

fragment WidgetQuestion on Submission_WidgetQuestion {
  gradeSettings {
    maxScore
    graderType
    __typename
  }
  partId: id
  questionSchema {
    prompt {
      ...SubmissionCmlContent
      ...SubmissionHtmlContent
      __typename
    }
    widgetSessionId
    __typename
  }
  widgetResponse: response {
    answer
    __typename
  }
  __typename
}

fragment SubmissionPart on Submission_SubmissionPart {
  ...CheckboxQuestion
  ...CheckboxReflectQuestion
  ...CodeExpressionQuestion
  ...FileUploadQuestion
  ...MathQuestion
  ...MultipleChoiceQuestion
  ...MultipleChoiceReflectQuestion
  ...MultipleFillableBlanksQuestion
  ...NumericQuestion
  ...OffPlatformQuestion
  ...PlainTextQuestion
  ...RegexQuestion
  ...RichTextQuestion
  ...TextBlock
  ...TextExactMatchQuestion
  ...TextReflectQuestion
  ...UrlQuestion
  ...WidgetQuestion
  __typename
}

fragment Submission on Submission_Submission {
  id
  parts {
    ...SubmissionPart
    __typename
  }
  instructions {
    ...SubmissionInstructions
    __typename
  }
  lastSavedAt
  __typename
}

fragment InProgressAttempt on Submission_InProgressAttempt {
  id
  allowedDuration
  draft {
    ...Submission
    __typename
  }
  autoSubmissionRequired
  remainingDuration
  startedTime
  submissionsAllowed
  submissionsMade
  submissionsRemaining
  __typename
}

fragment LastSubmission on Submission_LastSubmission {
  id
  submission {
    ...Submission
    __typename
  }
  submittedAt
  __typename
}

fragment NextAttempt on Submission_NextAttempt {
  allowedDuration
  submissionsAllowed
  __typename
}

fragment SubmissionRateLimiterConfig on Submission_RateLimiterConfig {
  attemptsRemainingIncreasesAt
  maxPerInterval
  timeIntervalDuration
  __typename
}

fragment Attempts on Submission_Attempts {
  lastSubmission {
    ...LastSubmission
    __typename
  }
  nextAttempt {
    ...NextAttempt
    __typename
  }
  attemptsAllowed
  attemptsMade
  attemptsRemaining
  inProgressAttempt {
    ...InProgressAttempt
    __typename
  }
  rateLimiterConfig {
    ...SubmissionRateLimiterConfig
    __typename
  }
  __typename
}

fragment AssignmentOutcome on Submission_AssignmentOutcome {
  earnedGrade
  gradeOverride {
    original
    override
    __typename
  }
  isPassed
  latePenaltyRatio
  __typename
}

fragment IntegrityAutoProctorSettings on Integrity_AutoProctorSettings {
  enabled
  clientId
  hashedAttemptId
  __typename
}

fragment IntegrityHonorlockSettings on Integrity_HonorlockSettings {
  enabled
  __typename
}

fragment IntegrityLockingBrowserSettings on Integrity_LockingBrowserSettings {
  enabled
  enabledForCurrentUser
  __typename
}

fragment IntegrityCourseraProctoringSettings on Integrity_CourseraProctoringSettings {
  enabled
  configuration {
    primaryCameraConfig {
      cameraStatus
      recordingStatus
      monitoringStatus
      __typename
    }
    secondaryCameraConfig {
      cameraStatus
      recordingStatus
      monitoringStatus
      __typename
    }
    __typename
  }
  __typename
}

fragment IntegrityVivaExamSettings on Integrity_VivaExamSettings {
  status
  __typename
}

fragment IntegritySession on Session_Session {
  id
  isPrivate
  __typename
}

fragment AcademicIntegritySettings on Integrity_IntegritySettings {
  attemptId
  session {
    ...IntegritySession
    __typename
  }
  honorlockSettings {
    ...IntegrityHonorlockSettings
    __typename
  }
  lockingBrowserSettings {
    ...IntegrityLockingBrowserSettings
    __typename
  }
  autoProctorSettings {
    ...IntegrityAutoProctorSettings
    __typename
  }
  courseraProctoringSettings {
    ...IntegrityCourseraProctoringSettings
    __typename
  }
  vivaExamSettings {
    ...IntegrityVivaExamSettings
    __typename
  }
  __typename
}

fragment Assignment on Submission_Assignment {
  id
  passingFraction
  assignmentType
  assignmentGradingType
  gradeSelectionStrategy
  requiredMobileFeatures
  learnerFeedbackVisibility
  __typename
}

fragment SlackIntegrationMetadata on Submission_SlackIntegrationMetadata {
  slackGroupId
  slackTeamId
  slackTeamDomain
  __typename
}

fragment SlackProfile on Submission_SlackProfile {
  slackTeamId
  slackUserId
  slackName
  deletedOrInactive
  __typename
}

fragment UserProfile on Submission_UserProfile {
  id
  email
  fullName
  photoUrl
  slackProfile {
    ...SlackProfile
    __typename
  }
  __typename
}

fragment TeamSubmitter on Submission_TeamSubmitter {
  id
  name
  teamActivityDescription
  slackIntegrationMetadata {
    ...SlackIntegrationMetadata
    __typename
  }
  memberProfiles {
    ...UserProfile
    __typename
  }
  __typename
}

fragment IndividualSubmitter on Submission_IndividualSubmitter {
  id
  __typename
}

fragment QueryStateSuccess on Submission_SubmissionState {
  allowedAction
  assignment {
    ...Assignment
    __typename
  }
  integritySettings {
    ...AcademicIntegritySettings
    __typename
  }
  submitter {
    ...IndividualSubmitter
    ...TeamSubmitter
    __typename
  }
  attempts {
    ...Attempts
    __typename
  }
  feedback {
    feedbackId: id
    outcome {
      ...OverallOutcome
      __typename
    }
    __typename
  }
  outcome {
    ...AssignmentOutcome
    __typename
  }
  manualGradingStatus
  warnings
  __typename
}

query QueryState($courseId: ID!, $itemId: ID!) {
  SubmissionState {
    queryState(courseId: $courseId, itemId: $itemId) {
      ... on Submission_QueryStateFailure {
        ...QueryStateFailure
        __typename
      }
      ... on Submission_SubmissionState {
        ...QueryStateSuccess
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment OverallOutcome on Submission_OverallOutcome {
  latestScore
  highestScore
  maxScore
  __typename
}

fragment SubmissionInstructions on Submission_Instructions {
  overview {
    ...SubmissionCmlContent
    ...SubmissionHtmlContent
    __typename
  }
  reviewCriteria {
    ...SubmissionCmlContent
    ...SubmissionHtmlContent
    __typename
  }
  __typename
}

fragment QueryStateFailure on Submission_QueryStateFailure {
  errors {
    ...SubmissionInvalidAttemptIdError
    ...SubmissionInvalidHonorlockSessionError
    ...SubmissionNoAttemptInProgressError
    ...SubmissionNoOpenDraftError
    ...SubmissionQueryState_IpNotAllowedError
    ...SubmissionQueryState_TeamNotAssignedError
    ...SubmissionReworkSubmission_NoSubmissionToReworkError
    ...SubmissionSaveResponses_InvalidResponsesError
    ...SubmissionStaffGradingStartedError
    ...SubmissionStartAttempt_OutOfAttemptsError
    __typename
  }
  __typename
}

fragment SubmissionInvalidAttemptIdError on Submission_InvalidAttemptIdError {
  errorCode
  __typename
}

fragment SubmissionInvalidHonorlockSessionError on Submission_InvalidHonorlockSessionError {
  errorCode
  __typename
}

fragment SubmissionNoAttemptInProgressError on Submission_NoAttemptInProgressError {
  errorCode
  __typename
}

fragment SubmissionNoOpenDraftError on Submission_NoOpenDraftError {
  errorCode
  __typename
}

fragment SubmissionQueryState_IpNotAllowedError on Submission_QueryState_IPNotAllowedError {
  errorCode
  __typename
}

fragment SubmissionQueryState_TeamNotAssignedError on Submission_QueryState_TeamNotAssignedError {
  errorCode
  __typename
}

fragment SubmissionReworkSubmission_NoSubmissionToReworkError on Submission_ReworkSubmission_NoSubmissionToReworkError {
  errorCode
  __typename
}

fragment SubmissionSaveResponses_InvalidResponsesError on Submission_SaveResponses_InvalidResponsesError {
  errorCode
  __typename
}

fragment SubmissionStaffGradingStartedError on Submission_StaffGradingStartedError {
  errorCode
  __typename
}

fragment SubmissionStartAttempt_OutOfAttemptsError on Submission_StartAttempt_OutOfAttemptsError {
  errorCode
  __typename
}

fragment SubmissionCmlContent on CmlContent {
  cmlValue
  dtdId
  htmlWithMetadata {
    html
    metadata {
      hasAssetBlock
      hasCodeBlock
      hasMath
      isPlainText
      __typename
    }
    __typename
  }
  __typename
}

fragment SubmissionHtmlContent on Submission_HtmlContent {
  value
  __typename
}

fragment Option on Submission_MultipleChoiceOption {
  display {
    ...SubmissionCmlContent
    ...SubmissionHtmlContent
    __typename
  }
  optionId: id
  __typename
}

fragment TextBlock on Submission_TextBlock {
  partId: id
  title
  body {
    ...SubmissionCmlContent
    __typename
  }
  __typename
}`;

    try {
        const body = JSON.stringify({
            operationName: "QueryState",
            query: query,
            variables: {
                courseId: courseId,
                itemId: itemId
            }
        });

        const resp = await fetch(graphqlUrl, {
            method: 'POST',
            headers: headers,
            body: body,
            credentials: 'include'
        });

        if (!resp.ok) {
            log(`GraphQL QueryState Failed: ${resp.status}`);
            return;
        }

        const data = await resp.json();
        
        // Navigate the massive response structure
        const queryState = data.data?.SubmissionState?.queryState;
        
        if (!queryState) {
            log("No queryState in response.");
            return;
        }

        // Check for in-progress attempt
        const attempts = queryState.attempts;
        const inProgress = attempts?.inProgressAttempt;
        
        if (inProgress && inProgress.draft && inProgress.draft.parts) {
            const parts = inProgress.draft.parts;
            log(`Found ${parts.length} parts in the quiz.`);
            
            // Map GraphQL parts to a simpler format for the solver
            const questions = parts.map(part => {
                // Skip TextBlocks or informational parts
                if (part.__typename === 'Submission_TextBlock') {
                    return null;
                }

                // Extract prompt text from CML or HTML
                let promptText = "No prompt";
                const promptObj = part.questionSchema?.prompt;
                if (promptObj) {
                    if (promptObj.htmlWithMetadata?.html) promptText = promptObj.htmlWithMetadata.html;
                    else if (promptObj.value) promptText = promptObj.value;
                    else if (promptObj.cmlValue) promptText = promptObj.cmlValue;
                }
                
                // Clean HTML from prompt
                promptText = promptText.replace(/<[^>]*>/g, '').trim();

                // Extract options
                let options = [];
                if (part.questionSchema?.options) {
                    options = part.questionSchema.options.map(opt => {
                        let optText = "Option";
                        const disp = opt.display;
                        if (disp) {
                            if (disp.htmlWithMetadata?.html) optText = disp.htmlWithMetadata.html;
                            else if (disp.value) optText = disp.value;
                            else if (disp.cmlValue) optText = disp.cmlValue;
                        }
                        // Clean HTML from option
                        optText = optText.replace(/<[^>]*>/g, '').trim();
                        return { id: opt.optionId, text: optText };
                    });
                }

                return {
                    id: part.partId,
                    type: part.__typename, // e.g., Submission_MultipleChoiceQuestion
                    prompt: { text: promptText },
                    options: options
                };
            }).filter(q => q !== null); // Filter out nulls (TextBlocks)

            await solveQuestions('graphql', courseId, itemId, questions, headers, apiKeys);

        } else {
            log("No in-progress attempt found. You might need to start it manually once.");
        }

    } catch (e) {
        log(`Error in GraphQL QueryState: ${e.message}`);
    }
}

async function processSession(endpoint, sessionId, headers, apiKeys) {
    // Generic function to handle session state and solving
    try {
        const actionUrl = `https://www.coursera.org/api/${endpoint}/${sessionId}/actions?includes=gradingAttempts`;
        
        // Try standard action payload
        const actionBody = JSON.stringify({
            name: "getState",
            argument: []
        });

        const actionResp = await fetch(actionUrl, {
            method: 'POST',
            headers: headers,
            body: actionBody,
            credentials: 'include'
        });

        if (!actionResp.ok) {
            log(`Failed to get state: ${actionResp.status}`);
            return;
        }

        const actionData = await actionResp.json();
        
        // Extract questions from response
        // Structure varies: elements[0].result.questions or questionStates
        let questions = null;
        if (actionData.elements && actionData.elements[0].result && actionData.elements[0].result.questions) {
            questions = actionData.elements[0].result.questions;
        } else if (actionData.questionStates) {
            questions = actionData.questionStates;
        }

        if (questions && questions.length > 0) {
            log(`Found ${questions.length} questions!`);
            await solveQuestions(endpoint, sessionId, questions, headers, apiKeys);
        } else {
            log("No questions found in session state.");
            log("State Data: " + JSON.stringify(actionData).substring(0, 200));
        }
    } catch (e) {
        log(`Error processing session: ${e.message}`);
    }
}

async function solveQuestions(endpoint, courseId, itemId, questions, headers, apiKeys) {
    log("Starting solver...");
    
    // We need to collect all responses to save them
    const responsesToSave = [];

    for (const q of questions) {
        // Rate limit: Wait 1 second between requests
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
            let prompt = "";
            let isTextQuestion = false;

            // Determine if it's a text-based question
            if (q.type === 'Submission_PlainTextQuestion' || q.type === 'Submission_ShortAnswerQuestion' || q.type === 'Submission_TextExactMatchQuestion') {
                isTextQuestion = true;
                prompt = `
                Question: ${q.prompt.text}
                
                Please provide a short, direct answer to this question.
                Do not include any introductory text like "The answer is".
                Just provide the answer text itself. be accurate.
                `;
            } else {
                // Standard MCQ/Checkbox logic
                const optionsText = q.options.map((o, index) => `Option ${index + 1}: ${o.text}`).join('\n');
                prompt = `
                Question: ${q.prompt.text}
                
                ${optionsText}
                
                Please identify the correct option(s).
                Reply ONLY with the Option Number(s) (e.g., "Option 1" or "Option 1, Option 3").
                Do not include the text of the option.
                `;
            }
            
            let answerText = "";
            if (apiKeys.openai) {
                log(`Asking OpenAI (gpt-5.6-terra) for Question ${q.id}...`);
                answerText = await callOpenAI(apiKeys.openai, prompt);
                log(`OpenAI says: ${answerText}`);
            } else if (apiKeys.mistral) {
                log(`Asking Mistral for Question ${q.id}...`);
                answerText = await callMistral(apiKeys.mistral, prompt);
                log(`Mistral says: ${answerText}`);
            } else {
                throw new Error("No API key provided");
            }
            
            if (isTextQuestion) {
                // Handle Text Response
                let questionTypeEnum = null;
                if (q.type === 'Submission_PlainTextQuestion') questionTypeEnum = 'PLAIN_TEXT';
                else if (q.type === 'Submission_ShortAnswerQuestion') questionTypeEnum = 'SHORT_ANSWER';
                else if (q.type === 'Submission_TextExactMatchQuestion') questionTypeEnum = 'TEXT_EXACT_MATCH';

                if (questionTypeEnum) {
                    responsesToSave.push({
                        questionId: q.id,
                        questionType: questionTypeEnum,
                        questionResponse: {
                            plainTextResponse: {
                                plainText: answerText.trim()
                            }
                        }
                    });
                } else {
                     log(`Unsupported text question type: ${q.type}`);
                }

            } else {
                // Handle MCQ/Checkbox Response
                const correctOptions = [];
                const matches = answerText.match(/Option\s?(\d+)/gi);
                if (matches) {
                     matches.forEach(m => {
                         const numMatch = m.match(/\d+/);
                         if (numMatch) {
                             const num = parseInt(numMatch[0]) - 1; // 0-based index
                             if (q.options[num]) {
                                 correctOptions.push(q.options[num]);
                             }
                         }
                     });
                }
                
                if (correctOptions.length > 0) {
                    log(`Matched option(s): ${correctOptions.map(o => o.text).join(', ')}`);
                    
                    let questionTypeEnum = null;
                    if (q.type === 'Submission_MultipleChoiceQuestion') {
                        questionTypeEnum = 'MULTIPLE_CHOICE';
                    } else if (q.type === 'Submission_CheckboxQuestion') {
                        questionTypeEnum = 'CHECKBOX';
                    }

                    if (questionTypeEnum) {
                        if (q.type === 'Submission_MultipleChoiceQuestion') {
                            responsesToSave.push({
                                questionId: q.id,
                                questionType: questionTypeEnum,
                                questionResponse: {
                                    multipleChoiceResponse: {
                                        chosen: correctOptions[0].id
                                    }
                                }
                            });
                        } else if (q.type === 'Submission_CheckboxQuestion') {
                            responsesToSave.push({
                                questionId: q.id,
                                questionType: questionTypeEnum,
                                questionResponse: {
                                    checkboxResponse: {
                                        chosen: correctOptions.map(o => o.id)
                                    }
                                }
                            });
                        }
                    } else {
                        log(`Unsupported question type for auto-save: ${q.type}`);
                    }
                } else {
                    log(`Could not match Mistral answer to any option. Raw answer: ${answerText}`);
                }
            }
            
        } catch (e) {
            log(`Error solving question ${q.id}: ${e.message}`);
        }
    }

    // Save Responses
    if (responsesToSave.length > 0) {
        log(`Saving ${responsesToSave.length} responses...`);
        const submissionId = await saveResponsesGraphQL(headers, courseId, itemId, responsesToSave);
        
        if (submissionId) {
            // Submit Draft
            log(`Submitting quiz (Submission ID: ${submissionId})...`);
            await submitDraftGraphQL(headers, courseId, itemId, submissionId);
        } else {
            log("Could not get Submission ID, skipping submit.");
        }
    } else {
        log("No responses generated to save.");
    }
}

async function saveResponsesGraphQL(headers, courseId, itemId, responses) {
    const graphqlUrl = 'https://www.coursera.org/graphql-gateway?opname=Submission_SaveResponses';
    const query = `mutation Submission_SaveResponses($input: Submission_SaveResponsesInput!) {
  Submission_SaveResponses(input: $input) {
    ... on Submission_SaveResponsesSuccess {
      __typename
      submissionState {
        allowedAction
        warnings
        attempts {
          inProgressAttempt {
            draft {
              id
              lastSavedAt
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
    }
    ... on Submission_SaveResponsesFailure {
      __typename
      errors {
        errorCode
        __typename
      }
    }
    __typename
  }
}`;

    try {
        // The error said: Field "questionResponses" of required type "[Submission_QuestionResponseInput]!" was not provided.
        // So the input structure should be: { courseId, itemId, questionResponses: [...] }
        const body = JSON.stringify({
            operationName: "Submission_SaveResponses",
            query: query,
            variables: {
                input: {
                    courseId: courseId,
                    itemId: itemId,
                    questionResponses: responses // Renamed from 'responses' to 'questionResponses'
                }
            }
        });

        const resp = await fetch(graphqlUrl, {
            method: 'POST',
            headers: headers,
            body: body,
            credentials: 'include'
        });

        if (resp.ok) {
            log("Responses Saved Successfully!");
            const data = await resp.json();
            // We need the submissionId (draft id) for the submit step
            const draftId = data.data?.Submission_SaveResponses?.submissionState?.attempts?.inProgressAttempt?.draft?.id;
            return draftId;
        } else {
            const errorText = await resp.text();
            log(`Failed to save responses: ${resp.status} - ${errorText.substring(0, 300)}`);
            return null;
        }
    } catch(e) {
        log(`Error saving responses: ${e.message}`);
        return null;
    }
}

async function submitDraftGraphQL(headers, courseId, itemId, submissionId) {
    const graphqlUrl = 'https://www.coursera.org/graphql-gateway?opname=Submission_SubmitLatestDraft';
    const query = `mutation Submission_SubmitLatestDraft($input: Submission_SubmitLatestDraftInput!) {
  Submission_SubmitLatestDraft(input: $input) {
    ... on Submission_SubmitLatestDraftSuccess {
      __typename
      submissionState {
        allowedAction
        warnings
        __typename
      }
    }
    ... on Submission_SubmitLatestDraftFailure {
      __typename
      errors {
        errorCode
        __typename
      }
    }
    __typename
  }
}`;

    try {
        // The error said: Field "submissionId" of required type "ID!" was not provided.
        // So we need to pass the submissionId (which is the draft ID we get from saveResponses)
        const body = JSON.stringify({
            operationName: "Submission_SubmitLatestDraft",
            query: query,
            variables: {
                input: {
                    courseId: courseId,
                    itemId: itemId,
                    submissionId: submissionId
                }
            }
        });

        const resp = await fetch(graphqlUrl, {
            method: 'POST',
            headers: headers,
            body: body,
            credentials: 'include'
        });

        if (resp.ok) {
            log("Quiz Submitted Successfully!");
        } else {
            const errorText = await resp.text();
            log(`Failed to submit quiz: ${resp.status} - ${errorText.substring(0, 300)}`);
        }
    } catch(e) {
        log(`Error submitting quiz: ${e.message}`);
    }
}

async function processExamItem(userId, courseId, item, apiKeys) {
    try {
        log(`Attempting to start exam session for ${item.name}...`);
        
        const sessionUrl = `https://www.coursera.org/api/onDemandExamSessions.v1`;
        const csrfTokenMatch = document.cookie.match(/CSRF3-Token=([^;]+)/);
        const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : null;
        
        const headers = {
            'Content-Type': 'application/json',
            'x-csrf3-token': csrfToken,
            'x-coursera-application': 'ondemand',
            'x-requested-with': 'XMLHttpRequest',
        };

        // 1. Start Session
        // Note: userId is NOT sent in the body for this endpoint usually
        const startBody = JSON.stringify({
            courseId: courseId,
            itemId: item.id
        });

        const startResp = await fetch(sessionUrl, {
            method: 'POST',
            headers: headers,
            body: startBody,
            credentials: 'include'
        });

        if (!startResp.ok) {
            const text = await startResp.text();
            log(`Failed to start session: ${startResp.status} - ${text}`);
            return;
        }

        // The session ID is often in the X-Coursera-Id header for this endpoint
        const sessionId = startResp.headers.get('x-coursera-id');
        if (!sessionId) {
            log("Error: No Session ID returned in headers.");
            return;
        }
        
        log(`Session Started! Session ID: ${sessionId}`);

        // Delegate to generic session processor
        await processSession('onDemandExamSessions.v1', sessionId, headers, apiKeys);

    } catch (e) {
        log(`Error processing exam: ${e.message}`);
    }
}

async function callOpenAI(apiKey, prompt) {
    try {
        const url = 'https://api.openai.com/v1/chat/completions';
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5.6-terra',
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            })
        });
        
        if (!response.ok) {
            throw new Error(`OpenAI API Error: ${response.status}`);
        }
        
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "No response";
    } catch (e) {
        return "Error calling OpenAI: " + e.message;
    }
}

async function callMistral(apiKey, prompt) {
    try {
        const url = 'https://api.mistral.ai/v1/chat/completions';
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'mistral-small-latest',
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            })
        });
        
        if (!response.ok) {
            throw new Error(`Mistral API Error: ${response.status}`);
        }
        
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "No response";
    } catch (e) {
        return "Error calling Mistral: " + e.message;
    }
}
