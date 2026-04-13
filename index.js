/**
 * ================================================================
 * Hebron App — Firebase Cloud Functions 자동화 3종
 * ================================================================
 * 자동화 ①: 설교 등록 → 목장 나눔지 자동 생성·발송
 * 자동화 ②: 새 성도 등록 → 환영 이메일 자동화
 * 자동화 ③: VIP 등록 → 엥겔지수 기반 팔로업 이메일
 *
 * 배포 경로: C:\Users\ijigu\OneDrive\01_Coding\02_Hebron\Final\functions\
 * 배포 명령: firebase deploy --only functions
 * ================================================================
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret }       = require("firebase-functions/params");
const { logger }             = require("firebase-functions");
const admin                  = require("firebase-admin");
const Anthropic              = require("@anthropic-ai/sdk");
const nodemailer             = require("nodemailer");

// Firebase Admin 초기화 (이미 초기화된 경우 skip)
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ─── 환경변수 (Firebase Secret Manager) ───────────────────────
const ANTHROPIC_KEY  = defineSecret("ANTHROPIC_API_KEY");   // Claude API
const GMAIL_USER     = defineSecret("GMAIL_USER");           // 발신 Gmail
const GMAIL_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");   // Gmail 앱 비밀번호

// ─── Gmail 트랜스포터 생성 헬퍼 ───────────────────────────────
function createTransporter(user, pass) {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

// ─── Claude 클라이언트 생성 헬퍼 ─────────────────────────────
function createClaude(apiKey) {
  return new Anthropic({ apiKey });
}

// ─── 목자 이메일 목록 가져오기 ───────────────────────────────
async function getShepherdEmails() {
  const snap = await db
    .collection("members")
    .where("role", "==", "shepherd")
    .where("active", "==", true)
    .get();

  return snap.docs.map((d) => ({
    email: d.data().email,
    name:  d.data().name,
  }));
}

// ================================================================
// 자동화 ① — 설교 등록 → 목장 나눔지 자동 생성·발송
// ================================================================
// Firestore: /sermons/{sermonId}
// 새 설교 문서 필드: { title, scripture, mainPoints, date, preacher }
//
exports.autoSermonNotes = onDocumentCreated(
  {
    document: "sermons/{sermonId}",
    secrets:  [ANTHROPIC_KEY, GMAIL_USER, GMAIL_PASSWORD],
    region:   "us-central1",
  },
  async (event) => {
    const sermon = event.data.data();
    const { title, scripture, mainPoints, date, preacher } = sermon;

    logger.info(`[나눔지 자동화] 설교 등록: "${title}" — ${scripture}`);

    // ── 1. Claude로 목장 나눔지 생성 ──────────────────────────
    const claude = createClaude(ANTHROPIC_KEY.value());

    const prompt = `
당신은 GMC Seattle(시애틀지구촌교회) 목장 나눔지 작성 전문가입니다.
아래 주일 설교 정보를 바탕으로 목장 나눔지를 작성해 주세요.

[설교 정보]
- 제목: ${title}
- 성경 본문: ${scripture}
- 핵심 내용: ${mainPoints || "주어진 본문의 핵심 메시지"}
- 설교자: ${preacher || "담임목사"}
- 날짜: ${date || "이번 주"}

[작성 형식 — 반드시 아래 형식으로]
=========================
📖 본문: ${scripture}
🙏 제목: ${title}

[아이스브레이킹]
(가볍게 시작하는 질문 1개 — 설교와 연관된 일상 이야기)

[말씀 나눔] (5개 질문)
1. (관찰 질문: 본문에서 무엇을 발견했나?)
2. (해석 질문: 이 말씀이 의미하는 것은?)
3. (적용 질문 1: 나의 삶에서...)
4. (적용 질문 2: 이번 주 실천할 것은?)
5. (선교·전도 질문: VIP와 어떻게 나눌 수 있을까?)

[함께 기도]
(이번 주 중점 기도 제목 2-3가지)
=========================

성경 본문은 새번역을 사용하세요. 질문은 깊이 있되 일반 성도도 쉽게 나눌 수 있게 작성하세요.
    `.trim();

    const msg = await claude.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages:   [{ role: "user", content: prompt }],
    });

    const sharingNotes = msg.content[0].text;

    // ── 2. Firestore에 나눔지 저장 ────────────────────────────
    await db.collection("sermonNotes").add({
      sermonId:    event.params.sermonId,
      title,
      scripture,
      content:     sharingNotes,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      generatedBy: "claude-auto",
    });

    // ── 3. 목자 전체에게 이메일 발송 ──────────────────────────
    const shepherds   = await getShepherdEmails();
    const transporter = createTransporter(GMAIL_USER.value(), GMAIL_PASSWORD.value());

    const emailDate = date || new Date().toLocaleDateString("ko-KR");

    for (const shepherd of shepherds) {
      await transporter.sendMail({
        from:    `"GMC Seattle 담임목사" <${GMAIL_USER.value()}>`,
        to:      shepherd.email,
        subject: `[목장 나눔지] ${emailDate} — ${title}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1a2744;color:#f8f4ed;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="margin:0;font-size:18px">GMC Seattle 목장 나눔지</h2>
              <p style="margin:6px 0 0;font-size:13px;opacity:.8">${emailDate} 주일 설교</p>
            </div>
            <div style="background:#f8f4ed;padding:20px;border-radius:0 0 8px 8px">
              <p style="color:#5a4e3a;font-size:13px">안녕하세요, ${shepherd.name} 목자님!<br>
              이번 주 목장 나눔지를 자동으로 전달드립니다.</p>
              <div style="background:#fff;border:1px solid #d4c8a8;border-radius:8px;padding:16px;
                          white-space:pre-wrap;font-size:13px;line-height:1.8;color:#2a2218">
${sharingNotes}
              </div>
              <p style="color:#8a7a62;font-size:11px;margin-top:12px">
              이 이메일은 Hebron 앱 자동화 시스템이 발송했습니다. | GMC Seattle
              </p>
            </div>
          </div>
        `,
      });
      logger.info(`[나눔지] 발송 완료: ${shepherd.email}`);
    }

    // ── 4. 발송 결과 Firestore 기록 ──────────────────────────
    await db.collection("automationLogs").add({
      type:       "sermonNotes",
      sermonId:   event.params.sermonId,
      title,
      sentCount:  shepherds.length,
      sentAt:     admin.firestore.FieldValue.serverTimestamp(),
      status:     "success",
    });

    logger.info(`[나눔지 자동화] 완료 — ${shepherds.length}명 발송`);
  }
);

// ================================================================
// 자동화 ② — 새 성도 등록 → 환영 이메일 자동화
// ================================================================
// Firestore: /members/{memberId}
// 새 성도 문서 필드: { name, email, phone, cellGroup, shepherdId, joinDate }
//
exports.autoWelcomeEmail = onDocumentCreated(
  {
    document: "members/{memberId}",
    secrets:  [ANTHROPIC_KEY, GMAIL_USER, GMAIL_PASSWORD],
    region:   "us-central1",
  },
  async (event) => {
    const member = event.data.data();
    const { name, email, cellGroup, shepherdId, joinDate, role } = member;

    // 목자·운영진 등록 시에는 환영 이메일 skip
    if (role && role !== "member") {
      logger.info(`[환영 이메일] skip — role: ${role}`);
      return;
    }

    if (!email) {
      logger.warn(`[환영 이메일] 이메일 없음 — ${name}`);
      return;
    }

    logger.info(`[환영 이메일] 새 성도: ${name} (${email})`);

    // ── 1. 목자 정보 가져오기 ─────────────────────────────────
    let shepherdName = "목자";
    if (shepherdId) {
      const shepherdDoc = await db.collection("members").doc(shepherdId).get();
      if (shepherdDoc.exists) shepherdName = shepherdDoc.data().name;
    }

    // ── 2. Claude로 개인화 환영 편지 작성 ────────────────────
    const claude = createClaude(ANTHROPIC_KEY.value());

    const prompt = `
당신은 GMC Seattle(시애틀지구촌교회) 담임목사 김성수입니다.
새로 등록한 성도에게 따뜻하고 진심 어린 환영 편지를 작성해 주세요.

[성도 정보]
- 이름: ${name}님
- 목장: ${cellGroup || "미배정"} 목장
- 담당 목자: ${shepherdName} 목자
- 등록일: ${joinDate || new Date().toLocaleDateString("ko-KR")}

[작성 지침]
- 한국어로 작성 (300자 내외)
- 따뜻하고 진심 어린 톤
- Genesis 13:14 비전(북남동서) 또는 말씀 1절 자연스럽게 포함
- ${cellGroup} 목장과 ${shepherdName} 목자 구체적으로 언급
- 담임목사로서의 개인적인 환영 메시지
- 마지막에 "주 안에서, 시애틀지구촌교회 담임목사 김성수 드림" 서명
    `.trim();

    const msg = await claude.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 600,
      messages:   [{ role: "user", content: prompt }],
    });

    const welcomeMessage = msg.content[0].text;

    // ── 3. 성도에게 환영 이메일 발송 ─────────────────────────
    const transporter = createTransporter(GMAIL_USER.value(), GMAIL_PASSWORD.value());

    await transporter.sendMail({
      from:    `"김성수 담임목사 (GMC Seattle)" <${GMAIL_USER.value()}>`,
      to:      email,
      subject: `${name}님, GMC Seattle에 오신 것을 환영합니다! 🙏`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1a2744;padding:24px;border-radius:8px 8px 0 0;text-align:center">
            <h2 style="color:#c8962a;margin:0;font-size:20px">시애틀지구촌교회</h2>
            <p style="color:#f8f4ed;margin:6px 0 0;font-size:13px">GMC Seattle — 하나님 나라 공동체</p>
          </div>
          <div style="background:#f8f4ed;padding:24px;border-radius:0 0 8px 8px">
            <p style="color:#2a2218;font-size:14px;line-height:1.8;white-space:pre-wrap">${welcomeMessage}</p>
            <hr style="border:none;border-top:1px solid #d4c8a8;margin:20px 0">
            <p style="color:#8a7a62;font-size:11px;margin:0">
              GMC Seattle | Lynnwood, WA | gmcseattle.org<br>
              담당 목자: ${shepherdName} 목자 — 목장 모임에 대해 연락드릴 예정입니다.
            </p>
          </div>
        </div>
      `,
    });

    logger.info(`[환영 이메일] 발송 완료: ${email}`);

    // ── 4. 담당 목자에게도 알림 ───────────────────────────────
    if (shepherdId) {
      const shepherdDoc = await db.collection("members").doc(shepherdId).get();
      if (shepherdDoc.exists && shepherdDoc.data().email) {
        await transporter.sendMail({
          from:    `"Hebron 자동화 시스템" <${GMAIL_USER.value()}>`,
          to:      shepherdDoc.data().email,
          subject: `[목자 알림] ${name}님이 새로 등록하셨습니다`,
          html: `
            <div style="font-family:sans-serif;max-width:500px">
              <div style="background:#0F6E56;color:#fff;padding:14px;border-radius:8px 8px 0 0">
                <strong>새 목원 등록 알림</strong>
              </div>
              <div style="background:#e8f5e8;padding:16px;border-radius:0 0 8px 8px">
                <p style="margin:0;font-size:13px">
                  <strong>${shepherdName} 목자님</strong>, 안녕하세요!<br><br>
                  <strong>${name}</strong>님이 ${cellGroup || "목장"} 목장에 새로 등록하셨습니다.<br>
                  연락하셔서 첫 목장 모임에 초대해 주세요. 🙏
                </p>
                <p style="font-size:11px;color:#5a7a5a;margin-top:12px">
                  이메일: ${email || "미입력"} | 등록일: ${joinDate || "오늘"}
                </p>
              </div>
            </div>
          `,
        });
        logger.info(`[환영 이메일] 목자 알림 완료: ${shepherdDoc.data().email}`);
      }
    }

    // ── 5. 자동화 로그 ────────────────────────────────────────
    await db.collection("automationLogs").add({
      type:      "welcomeEmail",
      memberId:  event.params.memberId,
      name,
      email,
      sentAt:    admin.firestore.FieldValue.serverTimestamp(),
      status:    "success",
    });
  }
);

// ================================================================
// 자동화 ③ — VIP 등록 → 엥겔지수 기반 팔로업 이메일
// ================================================================
// Firestore: /vips/{vipId}
// VIP 문서 필드: { name, email, phone, engelScore(1-9), registeredBy, note }
//
exports.autoVipFollowup = onDocumentCreated(
  {
    document: "vips/{vipId}",
    secrets:  [ANTHROPIC_KEY, GMAIL_USER, GMAIL_PASSWORD],
    region:   "us-central1",
  },
  async (event) => {
    const vip = event.data.data();
    const { name, email, phone, engelScore, registeredBy, note } = vip;

    logger.info(`[VIP 팔로업] 새 VIP: ${name} — 엥겔지수 ${engelScore}`);

    if (!email && !phone) {
      logger.warn(`[VIP 팔로업] 연락처 없음 — ${name}`);
      return;
    }

    // ── 1. 등록한 목원 정보 가져오기 ─────────────────────────
    let memberName = "목원";
    if (registeredBy) {
      const memberDoc = await db.collection("members").doc(registeredBy).get();
      if (memberDoc.exists) memberName = memberDoc.data().name;
    }

    // ── 2. 엥겔지수별 메시지 전략 결정 ───────────────────────
    const score = parseInt(engelScore) || 5;

    const engelStrategy = {
      // 1-3: 하나님 개념 없음/적대적
      low: {
        range:   "1-3",
        label:   "초기 접촉 단계",
        approach:"자연스러운 관심과 섬김. 기독교를 직접 언급하지 않고 먼저 신뢰 형성",
        action:  "커피 한 잔 제안, 이민 정착 도움 제공, 공통 관심사 나누기",
      },
      // 4-6: 기독교에 관심/교회 방문 고려
      mid: {
        range:   "4-6",
        label:   "관심·탐색 단계",
        approach:"교회와 복음에 대한 궁금증 해소. 유튜브 영상·행사 초대 적절",
        action:  "GMC YouTube 설교 영상 공유, 교회 이벤트 초대, 성경 공부 제안",
      },
      // 7-9: 결신 준비/새신자
      high: {
        range:   "7-9",
        label:   "결신·제자훈련 단계",
        approach:"복음을 명확히 제시하고 교회 등록·목장 초대 적극 권유",
        action:  "주일 예배 함께 참석, 목장 모임 초대, 삶 공부 등록 안내",
      },
    };

    const strategy =
      score <= 3 ? engelStrategy.low :
      score <= 6 ? engelStrategy.mid :
                   engelStrategy.high;

    // ── 3. Claude로 팔로업 메시지 생성 ───────────────────────
    const claude = createClaude(ANTHROPIC_KEY.value());

    const prompt = `
당신은 GMC Seattle 목원 ${memberName}입니다.
VIP(전도 대상자)에게 보낼 따뜻하고 자연스러운 팔로업 메시지를 작성해 주세요.

[VIP 정보]
- 이름: ${name}님
- 엥겔지수: ${score} (${strategy.label})
- 특이사항: ${note || "없음"}

[접근 전략: 엥겔지수 ${strategy.range} — ${strategy.label}]
- 접근 방식: ${strategy.approach}
- 권장 행동: ${strategy.action}

[메시지 작성 지침]
- 이메일 형식 (제목 + 본문)
- 200-250자 내외로 간결하게
- 자연스럽고 진심 어린 톤 (종교적 강요 없이)
- 엥겔지수 ${score}에 맞는 적절한 거리감 유지
- 구체적인 다음 단계 제안 1가지 포함
- 서명: "${memberName} 드림"

결과를 아래 형식으로:
제목: [이메일 제목]
---
[본문 내용]
    `.trim();

    const msg = await claude.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages:   [{ role: "user", content: prompt }],
    });

    const rawMessage  = msg.content[0].text;
    const titleMatch  = rawMessage.match(/제목:\s*(.+)/);
    const emailSubject = titleMatch ? titleMatch[1].trim() : `${name}님께`;
    const bodyStart    = rawMessage.indexOf("---");
    const emailBody    = bodyStart >= 0
      ? rawMessage.slice(bodyStart + 3).trim()
      : rawMessage;

    // ── 4. VIP에게 이메일 발송 ────────────────────────────────
    const transporter = createTransporter(GMAIL_USER.value(), GMAIL_PASSWORD.value());

    if (email) {
      await transporter.sendMail({
        from:    `"${memberName}" <${GMAIL_USER.value()}>`,
        to:      email,
        subject: emailSubject,
        html: `
          <div style="font-family:sans-serif;max-width:500px">
            <div style="padding:20px;background:#fff;border-radius:8px;
                        border:1px solid #e0e0e0;line-height:1.8">
              <p style="font-size:14px;color:#2a2218;white-space:pre-wrap">${emailBody}</p>
            </div>
          </div>
        `,
      });
      logger.info(`[VIP 팔로업] 이메일 발송: ${email} (엥겔 ${score})`);
    }

    // ── 5. 등록한 목원에게 코칭 팁 알림 ──────────────────────
    const memberDoc = await db.collection("members").doc(registeredBy || "").get();
    if (memberDoc.exists && memberDoc.data().email) {
      await transporter.sendMail({
        from:    `"Hebron VIP 시스템" <${GMAIL_USER.value()}>`,
        to:      memberDoc.data().email,
        subject: `[VIP 코칭] ${name}님 팔로업 메시지 발송 완료`,
        html: `
          <div style="font-family:sans-serif;max-width:500px">
            <div style="background:#1a2744;color:#c8962a;padding:12px;border-radius:8px 8px 0 0">
              <strong>VIP 팔로업 완료 알림</strong>
            </div>
            <div style="background:#f0ead8;padding:16px;border-radius:0 0 8px 8px;font-size:13px">
              <p><strong>${name}</strong>님께 팔로업 이메일이 자동 발송되었습니다.</p>
              <p style="background:#fff;border-radius:6px;padding:10px;margin:10px 0">
                <strong>엥겔지수 ${score} (${strategy.label})</strong><br>
                <em>다음 단계:</em> ${strategy.action}
              </p>
              <p style="color:#8a7a62;font-size:11px">
                이번 주 안에 직접 연락하시거나 만남을 가져보세요. 기도하며 함께 해 드리겠습니다! 🙏
              </p>
            </div>
          </div>
        `,
      });
    }

    // ── 6. VIP 문서에 팔로업 기록 업데이트 ───────────────────
    await db.collection("vips").doc(event.params.vipId).update({
      lastFollowup:    admin.firestore.FieldValue.serverTimestamp(),
      followupCount:   admin.firestore.FieldValue.increment(1),
      lastMessage:     emailBody.slice(0, 100) + "...",
      engelStrategy:   strategy.label,
      autoFollowupDone: true,
    });

    // ── 7. 30일 후 재팔로업 스케줄 기록 ─────────────────────
    const followupDate = new Date();
    followupDate.setDate(followupDate.getDate() + 30);

    await db.collection("followupSchedule").add({
      vipId:         event.params.vipId,
      vipName:       name,
      registeredBy,
      scheduledAt:   admin.firestore.Timestamp.fromDate(followupDate),
      engelScore:    score,
      status:        "pending",
      note:          `30일 후 팔로업 — 현재 엥겔지수 ${score}`,
    });

    // ── 8. 자동화 로그 ────────────────────────────────────────
    await db.collection("automationLogs").add({
      type:        "vipFollowup",
      vipId:       event.params.vipId,
      name,
      engelScore:  score,
      strategy:    strategy.label,
      emailSent:   !!email,
      sentAt:      admin.firestore.FieldValue.serverTimestamp(),
      status:      "success",
    });

    logger.info(`[VIP 팔로업] 완료 — ${name} (엥겔 ${score})`);
  }
);
