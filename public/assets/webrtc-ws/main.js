(async () => {
  const localVideoElem = document.getElementById("localVideo");
  const remoteVideoElem = document.getElementById("remoteVideo");
  const remoteAudioElem = document.getElementById("remoteAudio");

  if (!localVideoElem || !remoteVideoElem)
    throw new Error("Missing video element");
  if (!remoteAudioElem) throw new Error("Missing audio element");

  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    alert("Missing id in URL. Please provide ?id=ROOM_ID");
    throw new Error("Missing id in URL");
  }

  console.log("ID:", id);

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }, // STUN
      // { urls: 'turn:your.turn.server', username: 'u', credential: 'p' } // TURN
    ],
  });

  const candidates = [];

  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });
  localVideoElem.srcObject = localStream;

  /**
   * @param {string} event
   * @param {unknown | undefined   } data
   */
  const sendSignaling = async (event, data) => {
    return await new Promise((resolve) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ event, data }));
        resolve();
      } else {
        ws.addEventListener(
          "open",
          () => {
            ws.send(JSON.stringify({ event, data }));
            resolve();
          },
          { once: true }
        );
      }
    });
  };

  const sendOffer = async () => {
    const offer = await pc.createOffer();
    console.log("Send [offer].");
    await sendSignaling("offer", offer);
    await pc.setLocalDescription(offer);
  };

  const sendAnswer = async () => {
    const answer = await pc.createAnswer();
    console.log("Send [answer].");
    await sendSignaling("answer", answer);
    await pc.setLocalDescription(answer);
  };

  const sendCandidates = async (newCandidate = null, force = false) => {
    if (newCandidate) candidates.push(newCandidate);
    else if (!candidates.length) return;
    const items = candidates.splice(0);
    if (
      force ||
      pc.connectionState === "connecting" ||
      pc.connectionState === "connected"
    ) {
      console.log(`Send [candidates]: ${items.length}`);
      if (items.length === 1) await sendSignaling("candidate", items[0]);
      else await sendSignaling("candidates", items);
    } else {
      console.log(`Pending candidates...`);
      candidates.push(...items);
    }
  };

  const waitUntilConnected = async () => {
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timeout = undefined;
      /** @param {(() => void)|undefined} cb */
      const end = (cb) => {
        clearTimeout(timeout);
        pc.removeEventListener("connectionstatechange", onStateChange);
        cb?.();
      };
      const start = (timeoutMs = 30 * 1000) => {
        end();
        timeout = setTimeout(() => reject(), timeoutMs);
        pc.addEventListener("connectionstatechange", onStateChange);
      };
      const onStateChange = () => {
        switch (pc.connectionState) {
          case "new":
          case "connecting":
            start();
            break;
          case "connected":
            end(resolve);
            break;
          case "disconnected":
          case "failed":
          case "closed":
            end(reject);
            break;
        }
      };
      onStateChange();
    });
    const t1 = Date.now();
    console.log(`Connected in ${t1 - t0}ms`);
  };

  pc.addEventListener("datachannel", (ev) => {
    console.log("ondatachannel", ev.channel);
  });

  pc.addEventListener("track", (e) => {
    for (let i = 0; i < e.streams.length; ++i) {
      const remoteStream = e.streams[i];
      console.log(`Got remote stream${i}:`, e.track.kind);
      if (e.track.kind === "video") {
        if (remoteVideoElem.srcObject !== remoteStream) {
          remoteVideoElem.srcObject = remoteStream;
        }
      }
      if (e.track.kind === "audio") {
        if (remoteAudioElem.srcObject !== remoteStream) {
          remoteAudioElem.srcObject = remoteStream;
        }
      }
    }
  });

  pc.addEventListener("icecandidate", async (e) => {
    if (e.candidate) {
      sendCandidates(e.candidate);
    } else {
      console.log("All candidates have been discovered.");
    }
  });

  pc.addEventListener("negotiationneeded", async () => {
    if (pc.connectionState === "connected") await sendOffer();
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    console.log("ICE state:", pc.iceConnectionState);
  });

  pc.addEventListener("connectionstatechange", async () => {
    console.log("PC state:", pc.connectionState);

    if (
      pc.connectionState === "disconnected" ||
      pc.connectionState === "failed"
    ) {
      remoteVideoElem.srcObject = null;
      remoteAudioElem.srcObject = null;
      console.log("Reconnecting...");
      pc.restartIce();
    }
  });

  // WEBSOCKET

  const ws = new WebSocket(`${location.origin}/rooms/${id}`);

  ws.addEventListener("message", async (evt) => {
    const { event, data } = JSON.parse(evt.data);

    if (typeof event !== "string") return;

    if (data) console.log(`Received [${event}]:`, data);
    else console.log(`Received [${event}].`);

    switch (event) {
      case "ping": {
        await sendSignaling("pong");
        break;
      }
      case "offer-request": {
        await sendOffer();
        break;
      }
      case "offer": {
        await Promise.all([
          pc.setRemoteDescription(data).then(() => sendAnswer()),
          sendSignaling("candidates-request"),
          sendCandidates(null, true),
        ]);
        break;
      }
      case "answer": {
        await Promise.all([
          pc.setRemoteDescription(data),
          sendSignaling("candidates-request"),
          sendCandidates(null, true),
        ]);
        break;
      }
      case "candidate": {
        await pc.addIceCandidate(data);
        break;
      }
      case "candidates": {
        if (!Array.isArray(data)) break;
        await Promise.all(data.map((i) => pc.addIceCandidate(i)));
        break;
      }
      case "candidates-request": {
        await sendCandidates(null, true);
        break;
      }
    }
  });

  const itv = setInterval(() => {
    if (ws.readyState === ws.OPEN) sendSignaling("ping");
  }, 10 * 1000);

  ws.addEventListener("close", async (event) => {
    clearInterval(itv);
    console.log("CLOSED");
    alert(
      `Connection is closed: (${event.code}) ${event.reason ?? "Unknown Error"}`
    );
  });

  await new Promise((_resolve, _reject) => {
    if (ws.readyState === ws.OPEN) return _resolve();
    if (ws.readyState === ws.CLOSING) return _reject();
    if (ws.readyState === ws.CLOSING) return _reject();
    const resolve = () => (_resolve(), clean());
    const reject = () => (_reject(), clean());
    const clean = () => {
      ws.removeEventListener("open", resolve);
      ws.removeEventListener("error", resolve);
      ws.removeEventListener("close", resolve);
    };
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
    ws.addEventListener("close", reject, { once: true });
  });

  await waitUntilConnected();
})();
