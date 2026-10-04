export const RETOOLING_QUIZ_QUESTION_COUNT = 5;
export const RETOOLING_QUIZ_OPTION_COUNT = 4;
export const MAX_PRACTICAL_PHOTO_BASE64_CHARS = 500 * 1024;
const MAX_PRACTICAL_PHOTO_DECODED_BYTES = 384 * 1024;

export interface RetoolingQuizQuestion {
  q: string;
  options: string[];
  correct: number;
}

export class RetoolingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetoolingValidationError";
  }
}

export function validateQuizQuestionSet(
  value: unknown,
  allowEmpty = false,
): RetoolingQuizQuestion[] {
  if (!Array.isArray(value)) {
    throw new RetoolingValidationError("quiz_questions must be an array.");
  }
  if (allowEmpty && value.length === 0) return [];
  if (value.length !== RETOOLING_QUIZ_QUESTION_COUNT) {
    throw new RetoolingValidationError(
      `quiz_questions must contain exactly ${RETOOLING_QUIZ_QUESTION_COUNT} questions.`,
    );
  }

  return value.map((item, questionIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RetoolingValidationError(
        `Question ${questionIndex + 1} must be an object.`,
      );
    }
    const question = item as Record<string, unknown>;
    if (
      typeof question.q !== "string" ||
      question.q.trim().length < 1 ||
      question.q.length > 500
    ) {
      throw new RetoolingValidationError(
        `Question ${questionIndex + 1} needs a prompt of 1 to 500 characters.`,
      );
    }
    if (
      !Array.isArray(question.options) ||
      question.options.length !== RETOOLING_QUIZ_OPTION_COUNT ||
      question.options.some(
        (option) =>
          typeof option !== "string" ||
          option.trim().length < 1 ||
          option.length > 300,
      )
    ) {
      throw new RetoolingValidationError(
        `Question ${questionIndex + 1} must have exactly four non-empty options, each up to 300 characters.`,
      );
    }
    if (
      typeof question.correct !== "number" ||
      !Number.isInteger(question.correct) ||
      question.correct < 0 ||
      question.correct >= RETOOLING_QUIZ_OPTION_COUNT
    ) {
      throw new RetoolingValidationError(
        `Question ${questionIndex + 1} correct must be an option index from 0 to 3.`,
      );
    }
    return {
      q: question.q.trim(),
      options: question.options.map((option) => (option as string).trim()),
      correct: question.correct,
    };
  });
}

export function gradeRetoolingQuiz(
  questions: RetoolingQuizQuestion[],
  answers: unknown,
): { score: number; passableAnswers: number[]; correctAnswers: number[] } {
  if (
    !Array.isArray(answers) ||
    answers.length !== questions.length ||
    answers.some(
      (answer) =>
        typeof answer !== "number" ||
        !Number.isInteger(answer) ||
        answer < 0 ||
        answer >= RETOOLING_QUIZ_OPTION_COUNT,
    )
  ) {
    throw new RetoolingValidationError(
      `answers must contain one option index from 0 to 3 for each of the ${questions.length} questions.`,
    );
  }
  const correctAnswers = questions.map((question) => question.correct);
  const passableAnswers = answers as number[];
  const correctCount = correctAnswers.reduce(
    (count, correct, index) => count + (passableAnswers[index] === correct ? 1 : 0),
    0,
  );
  return {
    score: Math.round((correctCount / questions.length) * 100),
    passableAnswers,
    correctAnswers,
  };
}

export function isValidPracticalPhotoBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PRACTICAL_PHOTO_BASE64_CHARS
  ) {
    return false;
  }
  const match = value.match(
    /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/iu,
  );
  const payload = match?.[1];
  if (!payload || payload.length % 4 !== 0) return false;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedBytes = (payload.length / 4) * 3 - padding;
  return decodedBytes > 0 && decodedBytes <= MAX_PRACTICAL_PHOTO_DECODED_BYTES;
}

export function canCompleteRetoolingModule(input: {
  started: boolean;
  quizPassed: boolean;
  hasPracticalPhoto: boolean;
  pdfConfigured: boolean;
  pdfRead: boolean;
}): boolean {
  return (
    input.started &&
    input.quizPassed &&
    input.hasPracticalPhoto &&
    (!input.pdfConfigured || input.pdfRead)
  );
}