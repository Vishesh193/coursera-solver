// Background Service Worker — persists across popup closes and page navigations
// Developed & Owned by Vishesh Arora

let discussionState = null; // { items, courseSlug, tabId, index, completed }

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start_discussion_navigation") {
        const { items, courseSlug, tabId } = request;
        discussionState = { items, courseSlug, tabId, index: 0, completed: 0 };
        processNextDiscussionItem();
        sendResponse({ status: "started" });
    }
    if (request.action === "discussion_item_done") {
        if (discussionState) {
            discussionState.completed++;
            discussionState.index++;
            processNextDiscussionItem();
        }
        sendResponse({ ok: true });
    }
    if (request.action === "bg_log") {
        // Forward log to popup if open
        chrome.runtime.sendMessage({ action: "log", data: request.message }).catch(() => {});
        sendResponse({ ok: true });
    }
    return true;
});

async function processNextDiscussionItem() {
    if (!discussionState) return;
    const { items, courseSlug, tabId, index, completed } = discussionState;

    if (index >= items.length) {
        // All done — notify popup
        chrome.runtime.sendMessage({
            action: "discussion_all_done",
            completed,
            total: items.length
        }).catch(() => {});
        // Navigate back to course home
        const homeUrl = `https://www.coursera.org/learn/${courseSlug}/home/welcome`;
        chrome.tabs.update(tabId, { url: homeUrl }).catch(() => {});
        discussionState = null;
        return;
    }

    const item = items[index];
    const total = items.length;

    // Notify popup of progress
    chrome.runtime.sendMessage({
        action: "discussion_progress",
        index,
        total,
        name: item.name
    }).catch(() => {});

    chrome.runtime.sendMessage({
        action: "log",
        data: `[${index + 1}/${total}] Navigating to: ${item.name}`
    }).catch(() => {});

    const itemUrl = `https://www.coursera.org/learn/${courseSlug}/item/${item.id}`;

    // Navigate the tab
    chrome.tabs.update(tabId, { url: itemUrl }, () => {
        // Listen for tab to finish loading
        function onUpdated(updatedTabId, changeInfo) {
            if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onUpdated);

        // Wait extra for React to fully render the discussion form (5 seconds)
        setTimeout(() => {
            // content.js is auto-injected by manifest — no need to re-inject
            // Just send the message to type and submit
            function trySubmit(attemptsLeft) {
                chrome.tabs.sendMessage(tabId, { action: "type_and_submit_reply" }, (resp) => {
                    if (chrome.runtime.lastError) {
                        if (attemptsLeft > 0) {
                            setTimeout(() => trySubmit(attemptsLeft - 1), 1500);
                        } else {
                            chrome.runtime.sendMessage({ action: "log", data: `[Failed - no content script] ${item.name}` }).catch(() => {});
                            advance();
                        }
                        return;
                    }
                    if (resp && resp.success) {
                        chrome.runtime.sendMessage({ action: "log", data: `[Replied ✓] ${item.name}` }).catch(() => {});
                    } else {
                        chrome.runtime.sendMessage({ action: "log", data: `[No form found] ${item.name}` }).catch(() => {});
                    }
                    advance();
                });
            }

            function advance() {
                if (discussionState) {
                    discussionState.completed++;
                    discussionState.index++;
                    // 2 second pause before next item
                    setTimeout(() => processNextDiscussionItem(), 2000);
                }
            }

            trySubmit(3); // try up to 3 times with 1.5s between
        }, 5000);
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
        // Safety timeout
        setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
        }, 12000);
    });
}
