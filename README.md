# AI 해커톤 FAQ 챗봇

DOCX FAQ 문서를 RAG/API 없이 정적 JSON 인덱스로 변환하고, 브라우저에서 Fuse.js로 검색하는 GitHub Pages용 챗봇입니다.

## 구조

- `scripts/build-faq-index.mjs`: 루트의 `.docx`를 읽어 `public/data/faq-index.json` 생성
- `src/App.tsx`: Fuse.js 검색, 섹션 필터, 출처 단락 표시, 스트리밍형 답변 연출
- `.github/workflows/deploy-pages.yml`: GitHub Pages 자동 배포

## 로컬 실행

```bash
npm install
npm run dev
```

## 빌드

```bash
npm run build
```

빌드 시 DOCX에서 FAQ 인덱스를 다시 생성합니다.

## GitHub Pages 배포

1. 이 폴더를 GitHub 저장소로 푸시합니다.
2. GitHub 저장소의 `Settings > Pages`에서 `Build and deployment` 소스를 `GitHub Actions`로 설정합니다.
3. `main` 브랜치에 푸시하면 workflow가 `dist`를 Pages로 배포합니다.
