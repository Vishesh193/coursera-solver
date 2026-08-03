// Developed & Owned by Vishesh Arora
function sendMessageWithFallback(tabId, message, onFail) {
    chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
            console.warn("Content script missing, attempting auto-injection...", chrome.runtime.lastError.message);
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error("Auto-injection failed:", chrome.runtime.lastError.message);
                    if (onFail) onFail();
                    return;
                }
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
                        if (chrome.runtime.lastError && onFail) {
                            onFail();
                        }
                    });
                }, 300);
            });
        }
    });
}

document.getElementById('startBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('startBtn').disabled = true;
    document.getElementById('status').innerText = "Starting...";

    // Show progress bar
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('progressText').style.display = 'block';

    sendMessageWithFallback(tab.id, { action: "start_skipping" }, () => {
        document.getElementById('status').innerText = "Error: Reload extension & refresh page.";
    });
});

document.getElementById('readBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('readBtn').disabled = true;
    document.getElementById('status').innerText = "Starting Readings...";

    // Show progress bar
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('progressText').style.display = 'block';

    sendMessageWithFallback(tab.id, { action: "start_reading_completion" }, () => {
        document.getElementById('status').innerText = "Error: Reload extension & refresh page.";
    });
});


// Load saved keys
chrome.storage.local.get(['mistralApiKey', 'openaiApiKey', 'geminiApiKey'], (result) => {
    if (result.mistralApiKey) {
        document.getElementById('apiKey').value = result.mistralApiKey;
    } else if (result.geminiApiKey) {
        document.getElementById('apiKey').value = result.geminiApiKey;
    }
    if (result.openaiApiKey) {
        document.getElementById('openaiApiKey').value = result.openaiApiKey;
    }
});

// Check for running process on load
(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes("coursera.org")) {
        chrome.tabs.sendMessage(tab.id, { action: "get_status" }, (response) => {
            if (chrome.runtime.lastError) return; // Content script might not be ready
            
            if (response && response.isRunning) {
                // Restore UI state
                document.getElementById('startBtn').disabled = true;
                document.getElementById('readBtn').disabled = true;
                document.getElementById('quizBtn').disabled = true;
                document.getElementById('completeBtn').disabled = true;
                
                document.getElementById('status').innerText = response.statusMessage;
                
                // Restore logs
                const logDiv = document.getElementById('log');
                response.logs.forEach(msg => {
                    const entry = document.createElement('div');
                    entry.innerText = msg;
                    logDiv.appendChild(entry);
                });
                logDiv.scrollTop = logDiv.scrollHeight;

                // Restore progress bar if applicable
                if (response.isRunning) {
                    document.getElementById('progressContainer').style.display = 'block';
                    document.getElementById('progressText').style.display = 'block';
                    
                    if (response.progress && response.progress.total > 0) {
                        const { current, total, message } = response.progress;
                        const percentage = Math.round((current / total) * 100);
                        document.getElementById('progressBar').style.width = percentage + '%';
                        document.getElementById('progressText').innerText = `${percentage}% - ${message}`;
                    } else {
                        // Initializing state
                        document.getElementById('progressBar').style.width = '0%';
                        document.getElementById('progressText').innerText = "Initializing...";
                    }
                }
            }
        });
    }
})();

document.getElementById('quizBtn').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value;
    const openaiApiKey = document.getElementById('openaiApiKey').value;
    if (!apiKey && !openaiApiKey) {
        document.getElementById('status').innerText = "Enter at least one API Key first!";
        return;
    }
    chrome.storage.local.set({ mistralApiKey: apiKey, openaiApiKey: openaiApiKey });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('quizBtn').disabled = true;
    document.getElementById('status').innerText = "Starting Quizzes, Labs & Assignments Solver...";

    sendMessageWithFallback(tab.id, { action: "start_quiz_solver", apiKeys: { mistral: apiKey, openai: openaiApiKey } }, () => {
        document.getElementById('status').innerText = "Error: Reload extension & refresh page.";
    });
});

document.getElementById('completeBtn').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value;
    const openaiApiKey = document.getElementById('openaiApiKey').value;
    if (!apiKey && !openaiApiKey) {
        alert("Please enter an API Key first.");
        return;
    }
    
    // Save keys
    chrome.storage.local.set({ mistralApiKey: apiKey, openaiApiKey: openaiApiKey });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes("coursera.org")) {
        document.getElementById('status').innerText = "Error: Not on Coursera!";
        return;
    }

    document.getElementById('completeBtn').disabled = true;
    document.getElementById('status').innerText = "Starting Course Completion...";
    
    // Show progress bar
    document.getElementById('progressContainer').style.display = 'block';
    document.getElementById('progressText').style.display = 'block';

    sendMessageWithFallback(tab.id, { action: "start_complete_course", apiKeys: { mistral: apiKey, openai: openaiApiKey } }, () => {
        document.getElementById('status').innerText = "Error: Reload extension & refresh page.";
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "log") {
        const logDiv = document.getElementById('log');
        const entry = document.createElement('div');
        entry.innerText = request.data;
        logDiv.appendChild(entry);
        logDiv.scrollTop = logDiv.scrollHeight;
    }
    if (request.action === "status") {
        document.getElementById('status').innerText = request.data;
    }
    if (request.action === "progress_update") {
        const { current, total, message } = request.data;
        document.getElementById('progressContainer').style.display = 'block';
        document.getElementById('progressText').style.display = 'block';
        let percentage = total > 0 ? Math.round((current / total) * 100) : 0;
        document.getElementById('progressBar').style.width = percentage + '%';
        document.getElementById('progressText').innerText = `${percentage}% - ${message}`;
    }
    if (request.action === "finished") {
        document.getElementById('startBtn').disabled = false;
        document.getElementById('readBtn').disabled = false;
        document.getElementById('quizBtn').disabled = false;
        document.getElementById('completeBtn').disabled = false;
        document.getElementById('status').innerText = "Process Finished!";
    }
});
