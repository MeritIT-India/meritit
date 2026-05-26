/* ============================================
   MeritIT — P2P Video Call · Application Logic
   ============================================ */

(() => {
    'use strict';

    // ── Quality Presets (optimized for bandwidth) ──
    const QUALITY_PRESETS = {
        low: {
            video: { width: 320, height: 240, frameRate: 15 },
            maxBitrate: 150000,   // 150 kbps
            label: 'Low BW'
        },
        medium: {
            video: { width: 640, height: 480, frameRate: 24 },
            maxBitrate: 500000,   // 500 kbps
            label: 'Balanced'
        },
        high: {
            video: { width: 1280, height: 720, frameRate: 30 },
            maxBitrate: 1500000,  // 1.5 Mbps
            label: 'HD'
        }
    };

    // ── State ──
    let peer = null;
    let currentCall = null;
    let localStream = null;
    let selectedQuality = 'medium';
    let isMicOn = true;
    let isVideoOn = true;
    let callStartTime = null;
    let timerInterval = null;
    let statsInterval = null;
    let incomingCallData = null;
    let previousBytesSent = 0;
    let previousBytesReceived = 0;
    let previousTimestamp = 0;
    let iceServersConfig = [];
    let retryCount = 0;
    const MAX_RETRIES = 2;

    // ── DOM Elements ──
    const $ = (id) => document.getElementById(id);

    const DOM = {
        // Screens
        lobbyScreen: $('lobby-screen'),
        callScreen: $('call-screen'),

        // Lobby
        myPeerId: $('my-peer-id'),
        copyIdBtn: $('copy-id-btn'),
        remotePeerId: $('remote-peer-id'),
        callBtn: $('call-btn'),

        // Videos
        localVideo: $('local-video'),
        remoteVideo: $('remote-video'),
        remotePlaceholder: $('remote-placeholder'),
        remoteStatusText: $('remote-status-text'),

        // Controls
        toggleMic: $('toggle-mic'),
        toggleVideo: $('toggle-video'),
        toggleStats: $('toggle-stats'),
        toggleScreen: $('toggle-screen'),
        hangUp: $('hang-up'),

        // Icons
        micOnIcon: $('mic-on-icon'),
        micOffIcon: $('mic-off-icon'),
        videoOnIcon: $('video-on-icon'),
        videoOffIcon: $('video-off-icon'),

        // Stats
        networkStats: $('network-stats'),
        statLatency: $('stat-latency'),
        statBitrate: $('stat-bitrate'),
        statPacketLoss: $('stat-packet-loss'),
        statFps: $('stat-fps'),

        // Connection quality
        connectionQuality: $('connection-quality'),

        // Timer
        timerText: $('timer-text'),

        // Modal
        incomingModal: $('incoming-call-modal'),
        callerId: $('caller-id'),
        acceptCall: $('accept-call'),
        declineCall: $('decline-call'),

        // Toast
        toast: $('toast'),
        toastText: $('toast-text'),
    };

    // ── Initialize ──
    async function init() {
        // Fetch TURN credentials first, then init peer
        await fetchTurnCredentials();
        initPeer();
        bindEvents();
    }

    // ── Build ICE Server Config ──
    // Uses Metered.ca Open Relay — free, no signup required (static auth)
    // Docs: https://www.metered.ca/tools/openrelay/
    async function fetchTurnCredentials() {
        // Static-auth TURN servers from openrelay.metered.ca
        // No API key needed — free public relay (20 GB/month)
        iceServersConfig = [
            // STUN servers
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:openrelay.metered.ca:80' },

            // TURN via UDP port 80
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            },
            // TURN via TCP port 80
            {
                urls: 'turn:openrelay.metered.ca:80?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            },
            // TURN via UDP port 443
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            },
            // TURNS (TLS) via port 443 — penetrates deep-packet-inspection firewalls
            {
                urls: 'turns:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            },
            // TURN via TCP port 443
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            },
            // Static auth URL variant (used by Matrix/Nextcloud)
            {
                urls: 'turn:staticauth.openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            },
            {
                urls: 'turn:staticauth.openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            },
            {
                urls: 'turns:staticauth.openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayprojectsecret'
            }
        ];

        console.log('✓ ICE servers ready:', iceServersConfig.length, 'servers configured');
    }

    // ── PeerJS Initialization ──
    function initPeer() {
        // Generate short readable ID
        const id = generateShortId();

        peer = new Peer(id, {
            config: {
                iceServers: iceServersConfig,
                iceCandidatePoolSize: 10, // Pre-fetch ICE candidates for faster connection
            },
            debug: 1 // Show warnings/errors in console
        });

        peer.on('open', (id) => {
            DOM.myPeerId.textContent = id;
            DOM.copyIdBtn.disabled = false;
            DOM.callBtn.disabled = false;
            showToast('Connected to signaling server ✓');
        });

        peer.on('call', (call) => {
            incomingCallData = call;
            DOM.callerId.textContent = `Peer: ${call.peer}`;
            DOM.incomingModal.classList.remove('hidden');

            // Play ringtone feedback (vibration if available)
            if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
        });

        peer.on('error', (err) => {
            console.error('PeerJS Error:', err);
            if (err.type === 'peer-unavailable') {
                showToast('⚠ Peer not found. Check the ID and try again.');
            } else if (err.type === 'disconnected') {
                showToast('⚠ Disconnected. Reconnecting...');
                peer.reconnect();
            } else {
                showToast(`⚠ ${err.message || 'Connection error'}`);
            }
        });

        peer.on('disconnected', () => {
            showToast('Reconnecting to server...');
            setTimeout(() => {
                if (peer && !peer.destroyed) peer.reconnect();
            }, 2000);
        });
    }

    // ── Generate short memorable ID ──
    function generateShortId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let id = '';
        for (let i = 0; i < 6; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
        return id;
    }

    // ── Bind Events ──
    function bindEvents() {
        // Copy ID
        DOM.copyIdBtn.addEventListener('click', () => {
            const id = DOM.myPeerId.textContent;
            navigator.clipboard.writeText(id).then(() => {
                showToast('Room ID copied! Share it with your peer.');
            }).catch(() => {
                // Fallback
                const ta = document.createElement('textarea');
                ta.value = id;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast('Room ID copied!');
            });
        });

        // Call button
        DOM.callBtn.addEventListener('click', () => {
            const remoteId = DOM.remotePeerId.value.trim().toUpperCase();
            if (!remoteId) {
                showToast('Please enter a Room ID');
                DOM.remotePeerId.focus();
                return;
            }
            if (remoteId === DOM.myPeerId.textContent) {
                showToast('You cannot call yourself!');
                return;
            }
            retryCount = 0;
            initiateCall(remoteId);
        });

        // Enter key on input
        DOM.remotePeerId.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') DOM.callBtn.click();
        });

        // Auto-uppercase input
        DOM.remotePeerId.addEventListener('input', (e) => {
            e.target.value = e.target.value.toUpperCase();
        });

        // Quality selector
        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedQuality = btn.dataset.quality;
            });
        });

        // Call controls
        DOM.toggleMic.addEventListener('click', toggleMicrophone);
        DOM.toggleVideo.addEventListener('click', toggleCamera);
        DOM.toggleStats.addEventListener('click', toggleStatsOverlay);
        DOM.toggleScreen.addEventListener('click', toggleScreenShare);
        DOM.hangUp.addEventListener('click', endCall);

        // Incoming call modal
        DOM.acceptCall.addEventListener('click', () => {
            DOM.incomingModal.classList.add('hidden');
            if (incomingCallData) answerCall(incomingCallData);
        });

        DOM.declineCall.addEventListener('click', () => {
            DOM.incomingModal.classList.add('hidden');
            if (incomingCallData) {
                incomingCallData.close();
                incomingCallData = null;
            }
        });

        // Draggable local video PiP
        makeDraggable(document.querySelector('.local-video-wrapper'));
    }

    // ── Get User Media ──
    async function getUserMedia() {
        const preset = QUALITY_PRESETS[selectedQuality];
        const constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                // Lower sample rate for low bandwidth
                sampleRate: selectedQuality === 'low' ? 16000 : 48000,
            },
            video: {
                width: { ideal: preset.video.width },
                height: { ideal: preset.video.height },
                frameRate: { ideal: preset.video.frameRate, max: preset.video.frameRate },
                facingMode: 'user',
            }
        };

        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            DOM.localVideo.srcObject = localStream;
            return localStream;
        } catch (err) {
            console.error('Media error:', err);
            // Try audio only
            try {
                showToast('Camera unavailable. Using audio only.');
                localStream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio, video: false });
                DOM.localVideo.srcObject = localStream;
                isVideoOn = false;
                updateVideoIcon();
                return localStream;
            } catch (audioErr) {
                showToast('⚠ Cannot access camera or microphone');
                throw audioErr;
            }
        }
    }

    // ── Initiate Call ──
    async function initiateCall(remoteId) {
        try {
            showToast('Starting call...');
            const stream = await getUserMedia();

            const call = peer.call(remoteId, stream, {
                // Metadata for the callee
                metadata: { quality: selectedQuality }
            });

            if (!call) {
                showToast('⚠ Could not reach peer. Check the ID.');
                return;
            }

            setupCall(call);
        } catch (err) {
            console.error('Call initiation error:', err);
            showToast('⚠ Could not start call');
        }
    }

    // ── Answer Incoming Call ──
    async function answerCall(call) {
        try {
            showToast('Connecting...');
            const stream = await getUserMedia();
            call.answer(stream);
            setupCall(call);
        } catch (err) {
            console.error('Answer error:', err);
            showToast('⚠ Could not answer call');
        }
    }

    // ── Setup Call (common for both sides) ──
    function setupCall(call) {
        currentCall = call;

        // Switch to call screen
        DOM.lobbyScreen.classList.remove('active');
        DOM.callScreen.classList.add('active');

        DOM.remoteStatusText.textContent = 'Connecting...';

        // Set a timeout — if no stream arrives in 15s, something is wrong
        let streamReceived = false;
        const streamTimeout = setTimeout(() => {
            if (!streamReceived && currentCall) {
                showToast('⚠ No video received. Attempting ICE restart...');
                const pc = currentCall.peerConnection;
                if (pc && pc.restartIce) {
                    pc.restartIce();
                }
            }
        }, 15000);

        call.on('stream', (remoteStream) => {
            streamReceived = true;
            clearTimeout(streamTimeout);

            DOM.remoteVideo.srcObject = remoteStream;
            DOM.remotePlaceholder.style.display = 'none';

            // Apply bandwidth constraints
            applyBandwidthConstraints();

            // Start timer
            startCallTimer();

            // Start stats monitoring
            startStatsMonitoring();

            showToast('Connected! 🎉');
        });

        call.on('close', () => {
            clearTimeout(streamTimeout);
            showToast('Call ended');
            cleanupCall();
        });

        call.on('error', (err) => {
            clearTimeout(streamTimeout);
            console.error('Call error:', err);
            showToast('⚠ Call error occurred');
            cleanupCall();
        });

        // Monitor ICE connection state with detailed logging
        const pc = call.peerConnection;
        if (pc) {
            // Log all ICE candidates for debugging
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    const c = event.candidate;
                    console.log(`ICE Candidate: type=${c.type} protocol=${c.protocol} address=${c.address}:${c.port}`);
                } else {
                    console.log('ICE gathering complete');
                }
            };

            pc.onicegatheringstatechange = () => {
                console.log('ICE gathering state:', pc.iceGatheringState);
            };

            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                console.log('ICE connection state:', state);

                if (state === 'checking') {
                    DOM.remoteStatusText.textContent = 'Establishing connection...';
                } else if (state === 'connected' || state === 'completed') {
                    DOM.remotePlaceholder.style.display = 'none';
                    retryCount = 0; // Reset retry counter on success

                    // Log which candidate pair won
                    pc.getStats().then(stats => {
                        stats.forEach(report => {
                            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                                console.log('✓ Connected via candidate pair:', report);
                            }
                            if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                                console.log(`${report.type}: ${report.candidateType} ${report.protocol} ${report.address}:${report.port}`);
                            }
                        });
                    });
                } else if (state === 'disconnected') {
                    showToast('⚠ Connection unstable. Trying to reconnect...');
                    DOM.remoteStatusText.textContent = 'Reconnecting...';
                    DOM.remotePlaceholder.style.display = '';
                } else if (state === 'failed') {
                    console.error('ICE connection failed — no route between peers');

                    if (retryCount < MAX_RETRIES) {
                        retryCount++;
                        showToast(`⚠ Connection failed. Retrying with relay... (${retryCount}/${MAX_RETRIES})`);

                        // Close current call and retry with relay-only mode
                        const remoteId = call.peer;
                        cleanupCall();
                        retryWithRelay(remoteId);
                    } else {
                        showToast('⚠ Could not connect. Both peers may be behind strict firewalls.');
                        cleanupCall();
                    }
                }
            };

            pc.onconnectionstatechange = () => {
                console.log('Connection state:', pc.connectionState);
            };
        }
    }

    // ── Retry with TURN relay only ──
    async function retryWithRelay(remoteId) {
        showToast('🔄 Retrying with relay servers...');

        // Destroy old peer and create new one with relay-only config
        if (peer && !peer.destroyed) {
            peer.destroy();
        }

        // Get the same ID back (or generate new one)
        const myId = generateShortId();

        // Create peer with relay-only transport policy
        const relayConfig = {
            iceServers: iceServersConfig,
            iceTransportPolicy: 'relay', // Force TURN relay — this ALWAYS works if TURN server is reachable
            iceCandidatePoolSize: 10,
        };

        peer = new Peer(myId, {
            config: relayConfig,
            debug: 2
        });

        peer.on('open', async (id) => {
            DOM.myPeerId.textContent = id;
            showToast('Reconnected. Calling via relay...');

            // Re-initiate call
            try {
                const stream = localStream || await getUserMedia();
                const call = peer.call(remoteId, stream, {
                    metadata: { quality: selectedQuality, relay: true }
                });
                if (call) {
                    setupCall(call);
                } else {
                    showToast('⚠ Could not reach peer via relay. They may have disconnected.');
                }
            } catch (err) {
                console.error('Relay call error:', err);
                showToast('⚠ Relay connection failed');
            }
        });

        peer.on('call', (call) => {
            incomingCallData = call;
            DOM.callerId.textContent = `Peer: ${call.peer}`;
            DOM.incomingModal.classList.remove('hidden');
        });

        peer.on('error', (err) => {
            console.error('Relay peer error:', err);
            showToast(`⚠ ${err.message || 'Relay connection error'}`);
        });
    }

    // ── Apply Bandwidth Constraints ──
    function applyBandwidthConstraints() {
        if (!currentCall || !currentCall.peerConnection) return;

        const pc = currentCall.peerConnection;
        const preset = QUALITY_PRESETS[selectedQuality];
        const senders = pc.getSenders();

        senders.forEach(sender => {
            if (!sender.track) return;

            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }

            if (sender.track.kind === 'video') {
                params.encodings[0].maxBitrate = preset.maxBitrate;
                params.encodings[0].maxFramerate = preset.video.frameRate;
                // Prefer hardware-friendly codec
                params.encodings[0].scaleResolutionDownBy = 1;
            } else if (sender.track.kind === 'audio') {
                // Keep audio bitrate low for low bandwidth
                params.encodings[0].maxBitrate = selectedQuality === 'low' ? 24000 : 64000;
            }

            sender.setParameters(params).catch(err => {
                console.warn('Could not set bandwidth:', err);
            });
        });
    }

    // ── Controls ──
    function toggleMicrophone() {
        if (!localStream) return;
        isMicOn = !isMicOn;

        localStream.getAudioTracks().forEach(track => {
            track.enabled = isMicOn;
        });

        DOM.toggleMic.classList.toggle('muted', !isMicOn);
        DOM.micOnIcon.classList.toggle('hidden', !isMicOn);
        DOM.micOffIcon.classList.toggle('hidden', isMicOn);
    }

    function toggleCamera() {
        if (!localStream) return;
        isVideoOn = !isVideoOn;

        localStream.getVideoTracks().forEach(track => {
            track.enabled = isVideoOn;
        });

        updateVideoIcon();
    }

    function updateVideoIcon() {
        DOM.toggleVideo.classList.toggle('muted', !isVideoOn);
        DOM.videoOnIcon.classList.toggle('hidden', !isVideoOn);
        DOM.videoOffIcon.classList.toggle('hidden', isVideoOn);
    }

    function toggleStatsOverlay() {
        DOM.networkStats.classList.toggle('hidden');
        DOM.toggleStats.classList.toggle('active');
    }

    async function toggleScreenShare() {
        if (!currentCall || !currentCall.peerConnection) return;

        const senders = currentCall.peerConnection.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');

        if (!videoSender) {
            showToast('No video track to replace');
            return;
        }

        // Check if currently sharing screen
        if (DOM.toggleScreen.classList.contains('active')) {
            // Switch back to camera
            try {
                const preset = QUALITY_PRESETS[selectedQuality];
                const camStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: preset.video.width },
                        height: { ideal: preset.video.height },
                        frameRate: { ideal: preset.video.frameRate },
                        facingMode: 'user'
                    }
                });
                const camTrack = camStream.getVideoTracks()[0];
                await videoSender.replaceTrack(camTrack);

                // Update local video
                const oldTrack = localStream.getVideoTracks()[0];
                if (oldTrack) localStream.removeTrack(oldTrack);
                localStream.addTrack(camTrack);
                DOM.localVideo.srcObject = localStream;

                DOM.toggleScreen.classList.remove('active');
                showToast('Camera restored');
            } catch (err) {
                showToast('⚠ Could not switch to camera');
            }
        } else {
            // Share screen
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: 'always' },
                    audio: false
                });
                const screenTrack = screenStream.getVideoTracks()[0];
                await videoSender.replaceTrack(screenTrack);

                // Update local video
                DOM.localVideo.srcObject = screenStream;

                // When user stops sharing via browser UI
                screenTrack.onended = () => {
                    DOM.toggleScreen.click();
                };

                DOM.toggleScreen.classList.add('active');
                showToast('Screen sharing started');
            } catch (err) {
                if (err.name !== 'NotAllowedError') {
                    showToast('⚠ Could not share screen');
                }
            }
        }
    }

    // ── End Call ──
    function endCall() {
        if (currentCall) {
            currentCall.close();
        }
        cleanupCall();
    }

    function cleanupCall() {
        // Stop local stream
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        // Clear timers
        if (timerInterval) clearInterval(timerInterval);
        if (statsInterval) clearInterval(statsInterval);
        timerInterval = null;
        statsInterval = null;

        // Reset state
        currentCall = null;
        callStartTime = null;
        isMicOn = true;
        isVideoOn = true;
        previousBytesSent = 0;
        previousBytesReceived = 0;
        previousTimestamp = 0;

        // Reset UI
        DOM.localVideo.srcObject = null;
        DOM.remoteVideo.srcObject = null;
        DOM.remotePlaceholder.style.display = '';
        DOM.remoteStatusText.textContent = 'Waiting for peer...';
        DOM.timerText.textContent = '00:00';
        DOM.networkStats.classList.add('hidden');
        DOM.toggleStats.classList.remove('active');
        DOM.toggleScreen.classList.remove('active');
        DOM.toggleMic.classList.remove('muted');
        DOM.toggleVideo.classList.remove('muted');
        DOM.micOnIcon.classList.remove('hidden');
        DOM.micOffIcon.classList.add('hidden');
        DOM.videoOnIcon.classList.remove('hidden');
        DOM.videoOffIcon.classList.add('hidden');

        // Reset connection quality
        DOM.connectionQuality.className = 'connection-quality';

        // Switch back to lobby
        DOM.callScreen.classList.remove('active');
        DOM.lobbyScreen.classList.add('active');
    }

    // ── Call Timer ──
    function startCallTimer() {
        callStartTime = Date.now();

        timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
            const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const secs = String(elapsed % 60).padStart(2, '0');
            DOM.timerText.textContent = `${mins}:${secs}`;
        }, 1000);
    }

    // ── Stats Monitoring ──
    function startStatsMonitoring() {
        statsInterval = setInterval(async () => {
            if (!currentCall || !currentCall.peerConnection) return;

            const pc = currentCall.peerConnection;

            try {
                const stats = await pc.getStats();
                let latency = 0;
                let packetLoss = 0;
                let totalBytesSent = 0;
                let totalBytesReceived = 0;
                let fps = 0;
                let timestamp = 0;

                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        latency = report.currentRoundTripTime
                            ? Math.round(report.currentRoundTripTime * 1000)
                            : 0;
                        totalBytesSent = report.bytesSent || 0;
                        totalBytesReceived = report.bytesReceived || 0;
                        timestamp = report.timestamp;
                    }

                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        fps = report.framesPerSecond || 0;
                        if (report.packetsLost !== undefined && report.packetsReceived) {
                            const totalPackets = report.packetsReceived + report.packetsLost;
                            packetLoss = totalPackets > 0
                                ? ((report.packetsLost / totalPackets) * 100).toFixed(1)
                                : 0;
                        }
                    }
                });

                // Calculate bitrate
                let bitrate = 0;
                if (previousTimestamp > 0 && timestamp > previousTimestamp) {
                    const timeDiff = (timestamp - previousTimestamp) / 1000; // seconds
                    const bytesDiff = (totalBytesReceived - previousBytesReceived) + (totalBytesSent - previousBytesSent);
                    bitrate = Math.round((bytesDiff * 8) / timeDiff / 1000); // kbps
                }
                previousBytesSent = totalBytesSent;
                previousBytesReceived = totalBytesReceived;
                previousTimestamp = timestamp;

                // Update UI
                DOM.statLatency.textContent = latency > 0 ? `${latency}ms` : '--';
                DOM.statBitrate.textContent = bitrate > 0 ? `${bitrate}k` : '--';
                DOM.statPacketLoss.textContent = packetLoss > 0 ? `${packetLoss}%` : '0%';
                DOM.statFps.textContent = fps > 0 ? Math.round(fps) : '--';

                // Color-code latency
                if (latency > 0) {
                    DOM.statLatency.style.color = latency < 100 ? 'var(--success)' :
                        latency < 300 ? 'var(--warning)' : 'var(--danger)';
                }

                // Update connection quality bars
                updateConnectionQuality(latency, packetLoss, bitrate);

                // Adaptive quality: if network is bad, try to reduce bitrate
                if (latency > 500 || packetLoss > 5) {
                    adaptiveQualityReduce();
                }

            } catch (err) {
                // Stats API might not be supported
                console.warn('Stats error:', err);
            }
        }, 2000);
    }

    function updateConnectionQuality(latency, packetLoss, bitrate) {
        const el = DOM.connectionQuality;
        el.className = 'connection-quality';

        if (latency === 0 && bitrate === 0) return;

        if (latency < 100 && packetLoss < 1) {
            el.classList.add('excellent');
        } else if (latency < 200 && packetLoss < 3) {
            el.classList.add('good');
        } else if (latency < 400 && packetLoss < 8) {
            el.classList.add('fair');
        } else {
            el.classList.add('poor');
        }
    }

    // ── Adaptive Quality ──
    let adaptiveReductionApplied = false;

    function adaptiveQualityReduce() {
        if (adaptiveReductionApplied) return;
        if (!currentCall || !currentCall.peerConnection) return;

        adaptiveReductionApplied = true;
        showToast('📡 Low bandwidth detected. Reducing quality...');

        const pc = currentCall.peerConnection;
        const senders = pc.getSenders();

        senders.forEach(sender => {
            if (!sender.track || sender.track.kind !== 'video') return;

            const params = sender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
                // Aggressively reduce
                params.encodings[0].maxBitrate = 100000;  // 100 kbps
                params.encodings[0].maxFramerate = 12;
                params.encodings[0].scaleResolutionDownBy = 2;

                sender.setParameters(params).catch(console.warn);
            }
        });

        // Reset flag after 30 seconds to allow re-check
        setTimeout(() => {
            adaptiveReductionApplied = false;
        }, 30000);
    }

    // ── Draggable PiP ──
    function makeDraggable(element) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        element.addEventListener('mousedown', startDrag);
        element.addEventListener('touchstart', startDrag, { passive: false });

        function startDrag(e) {
            isDragging = true;
            element.style.cursor = 'grabbing';
            element.style.transition = 'none';

            const rect = element.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            if (e.type === 'touchstart') {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
            } else {
                startX = e.clientX;
                startY = e.clientY;
                e.preventDefault();
            }

            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDrag);
            document.addEventListener('touchmove', doDrag, { passive: false });
            document.addEventListener('touchend', stopDrag);
        }

        function doDrag(e) {
            if (!isDragging) return;
            e.preventDefault();

            let currentX, currentY;
            if (e.type === 'touchmove') {
                currentX = e.touches[0].clientX;
                currentY = e.touches[0].clientY;
            } else {
                currentX = e.clientX;
                currentY = e.clientY;
            }

            const dx = currentX - startX;
            const dy = currentY - startY;

            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;

            // Bounds
            const maxLeft = window.innerWidth - element.offsetWidth - 12;
            const maxTop = window.innerHeight - element.offsetHeight - 100;
            newLeft = Math.max(12, Math.min(newLeft, maxLeft));
            newTop = Math.max(12, Math.min(newTop, maxTop));

            element.style.position = 'absolute';
            element.style.left = newLeft + 'px';
            element.style.top = newTop + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
        }

        function stopDrag() {
            isDragging = false;
            element.style.cursor = 'grab';
            element.style.transition = '';
            document.removeEventListener('mousemove', doDrag);
            document.removeEventListener('mouseup', stopDrag);
            document.removeEventListener('touchmove', doDrag);
            document.removeEventListener('touchend', stopDrag);
        }
    }

    // ── Toast ──
    let toastTimeout = null;

    function showToast(message, duration = 3000) {
        DOM.toastText.textContent = message;
        DOM.toast.classList.remove('hidden');

        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            DOM.toast.classList.add('hidden');
        }, duration);
    }

    // ── Start App ──
    document.addEventListener('DOMContentLoaded', init);

})();
