import { useId, type FocusEvent } from "react";
import { ANSWER_MAX, EMPTY_DRAFT, pickOption, setOtherText, toggleOther, type AskQuestion, type QuestionDraft } from "../approvals-model";

interface Props {
  questions: readonly AskQuestion[];
  drafts: Readonly<Record<string, QuestionDraft>>;
  disabled: boolean;
  onChange: (question: string, draft: QuestionDraft) => void;
  onTextFocus?: (element: HTMLElement) => void;
}

export function ApprovalQuestions({ questions, drafts, disabled, onChange, onTextFocus }: Props) {
  const groupId = useId();
  const focusText = (event: FocusEvent<HTMLInputElement>) => onTextFocus?.(event.currentTarget);
  return (
    <div className="ask">
      {questions.map((question, index) => {
        const draft = drafts[question.question] ?? EMPTY_DRAFT;
        const name = `${groupId}-q${index}`;
        const type = question.multiSelect ? "checkbox" : "radio";
        const optionChecked = (label: string): boolean => (question.multiSelect || !draft.otherOn) && draft.selected.includes(label);
        return (
          <fieldset key={question.question} className="ask__q" disabled={disabled}>
            <legend className="ask__legend">
              {question.header && <span className="ask__header">{question.header}</span>}
              <span className="ask__text">{question.question}</span>
              {question.multiSelect && <span className="ask__hint">Pick any</span>}
            </legend>
            {question.options.map((option) => (
              <label key={option.label} className="ask__opt" title={option.description || undefined}>
                <input type={type} name={name} checked={optionChecked(option.label)} onChange={() => onChange(question.question, pickOption(draft, option.label, question.multiSelect))} />
                <span className="ask__label">{option.label}</span>
                {option.description && <span className="ask__desc">{option.description}</span>}
              </label>
            ))}
            <div className="ask__opt ask__opt--other">
              <input type={type} name={name} checked={draft.otherOn} aria-label="Other" onChange={() => onChange(question.question, toggleOther(draft, question.multiSelect))} />
              <input
                className="in ask__other"
                value={draft.other}
                maxLength={ANSWER_MAX}
                placeholder="Other"
                aria-label={`Other answer for: ${question.question}`}
                onFocus={focusText}
                onChange={(event) => onChange(question.question, setOtherText(draft, event.target.value))}
              />
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
