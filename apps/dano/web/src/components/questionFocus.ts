export type QuestionFocusChange =
  | {
      toolCallId: string;
      element: HTMLElement;
    }
  | {
      toolCallId: string;
      element: null;
      restoreInlinePosition: boolean;
    };
