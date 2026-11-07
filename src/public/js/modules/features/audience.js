// src/public/js/modules/features/audience.js

/**
 * Broadcaster Audience HUD Widget
 * 
 * Displays connected viewer count, individual viewer connection health (Online, Unstable, Failed),
 * and dynamically manages viewer list state.
 */

export function createAudienceWidget() {
    if (document.getElementById('audienceWidget')) return;

    // Inject fadeIn animation & responsive positioning style if not already present
    if (!document.getElementById('streamy-audience-style')) {
        const style = document.createElement('style');
        style.id = 'streamy-audience-style';
        style.innerHTML = `
            @keyframes audienceFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            @media (max-width: 1023px) {
                #audienceWidget {
                    bottom: auto !important;
                    top: max(4.75rem, calc(env(safe-area-inset-top, 0px) + 4rem)) !important;
                    left: 1rem !important;
                    width: min(220px, calc(100vw - 2rem)) !important;
                    padding: 10px 12px !important;
                }
            }
        `;
        document.head.appendChild(style);
    }

    const widget = document.createElement('div');
    widget.id = 'audienceWidget';
    Object.assign(widget.style, {
        position: 'fixed',
        bottom: '20px',
        left: '20px',
        width: '250px',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        borderRadius: '12px',
        padding: '15px',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        zIndex: '45',
        fontFamily: 'sans-serif',
        boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
        transition: 'opacity 0.3s ease'
    });

    widget.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px;">
            <span style="font-weight:bold; color:#a855f7;">Live Audience</span>
            <span id="viewerCount" style="background:#333; padding:2px 8px; border-radius:10px; font-size:12px;">0</span>
        </div>
        <div id="viewerList" style="max-height:150px; overflow-y:auto; font-size:13px;">
            <div id="emptyState" style="color:#666; font-style:italic; text-align:center; padding:10px;">Waiting for viewers...</div>
        </div>
    `;
    document.body.appendChild(widget);
}

export function updateAudienceList(id, status, color, username, totalCount) {
    const list = document.getElementById('viewerList');
    const count = document.getElementById('viewerCount');
    const emptyState = document.getElementById('emptyState');
    if (!list) return;

    if (emptyState) emptyState.style.display = 'none';

    let item = document.getElementById(`v-${id}`);
    
    let displayName = username;
    if (!displayName || displayName === "Viewer") {
        const shortId = id.substring(0, 4).toUpperCase();
        displayName = `Guest ${shortId}`;
    }

    if (!item) {
        item = document.createElement('div');
        item.id = `v-${id}`;
        Object.assign(item.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 0',
            borderBottom: '1px solid #333',
            animation: 'audienceFadeIn 0.5s'
        });
        list.appendChild(item);
    }

    // Safely construct viewer entry without innerHTML interpolation
    item.replaceChildren();

    const nameContainer = document.createElement('span');
    Object.assign(nameContainer.style, {
        display: 'flex',
        alignItems: 'center'
    });

    const dot = document.createElement('span');
    const safeColor = color || '#22c55e';
    Object.assign(dot.style, {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: safeColor,
        marginRight: '8px',
        boxShadow: `0 0 5px ${safeColor}`
    });

    const nameSpan = document.createElement('span');
    nameSpan.textContent = displayName;

    nameContainer.appendChild(dot);
    nameContainer.appendChild(nameSpan);

    const statusSpan = document.createElement('span');
    Object.assign(statusSpan.style, {
        fontSize: '11px',
        color: '#ccc'
    });
    statusSpan.textContent = status;

    item.appendChild(nameContainer);
    item.appendChild(statusSpan);

    if (count && typeof totalCount === 'number') {
        count.innerText = totalCount;
    }
}

export function removeViewerFromList(id, totalCount) {
    const item = document.getElementById(`v-${id}`);
    if (item) item.remove();
    
    const count = document.getElementById('viewerCount');
    if (count && typeof totalCount === 'number') {
        count.innerText = totalCount;
    }

    const emptyState = document.getElementById('emptyState');
    if (totalCount === 0 && emptyState) {
        emptyState.style.display = 'block';
    }
}

export function clearAudienceList() {
    const list = document.getElementById('viewerList');
    const count = document.getElementById('viewerCount');
    const emptyState = document.getElementById('emptyState');
    if (list) {
        Array.from(list.children).forEach(child => {
            if (child.id !== 'emptyState') child.remove();
        });
    }
    if (count) count.innerText = '0';
    if (emptyState) emptyState.style.display = 'block';
}

export function setViewerSpeaking(id, isSpeaking) {
    const item = document.getElementById(`v-${id}`);
    if (!item) return;
    const statusSpan = item.querySelector('span:last-child');
    if (!statusSpan) return;

    if (isSpeaking) {
        if (!item._prevStatus) item._prevStatus = statusSpan.textContent;
        statusSpan.style.color = '#ef4444';
        statusSpan.style.fontWeight = 'bold';
        statusSpan.textContent = '🎙️ Speaking';
    } else if (item._prevStatus) {
        statusSpan.style.color = '#ccc';
        statusSpan.style.fontWeight = 'normal';
        statusSpan.textContent = item._prevStatus;
        item._prevStatus = null;
    }
}

