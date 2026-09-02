import {
  DialogBody,
  ModalRoot,
  DialogControlsSection,
  Field,
  DialogButton,
  TextField,
  TextFieldProps,
  Focusable,
  IconsModule,
  Spinner,
  Marquee,
} from '@decky/ui';
import {
  FC,
  SVGAttributes,
  useMemo,
  useState,
  useEffect,
  useRef,
  VFC,
} from 'react';
import debounce from 'just-debounce';
import { SiSteam, SiEpicgames, SiOrigin, SiUbisoft, SiBattledotnet } from 'react-icons/si';
import { IconType } from 'react-icons';

import t from '../utils/i18n';
import FlashpointIcon from '../components/Icons/FlashpointIcon';
import EshopIcon from '../components/Icons/EshopIcon';
import GogIcon from '../components/Icons/GogIcon';

// @todo: find a better way to get this
const SearchIcon = Object.values(IconsModule).find((mod: any) => mod?.toString().includes('M27.5 24C29.4972 21.1283 30.3471')) as FC<SVGAttributes<SVGElement>>;

const utcYear = (date: number) => new Date(date * 1000).toLocaleString('en-US', { year: 'numeric', timeZone: 'UTC' });

const platformTypeMap: { [key: string]: IconType | VFC } = {
  steam: SiSteam,
  egs: SiEpicgames,
  origin: SiOrigin,
  uplay: SiUbisoft,
  gog: GogIcon,
  bnet: SiBattledotnet,
  flashpoint: FlashpointIcon,
  eshop: EshopIcon,
};
/*
  Store results are not SteamGridDB results.

  This read `game.types.length` unconditionally, and a PlayStation or Nintendo entry has
  no `types` at all - so opening the game picker on those sources crashed the whole page
  with "Cannot read properties of undefined (reading 'length')". Every field is optional
  now, and what a store does provide (platform, release) is shown instead.
*/
const GameLabel: FC<{game: any}> = ({ game }) => {
  const types: string[] = Array.isArray(game?.types) ? game.types : [];
  const platforms = types.filter((type) => platformTypeMap[type]);
  const release = typeof game?.release_date === 'number'
    ? utcYear(game.release_date)
    : String(game?.release ?? '').slice(0, 4);

  return (
    <span className="gamelabel">
      <Marquee>{game?.displayName ?? game?.name ?? ''}</Marquee>
      {release && <span className="release-date">({release})</span>}
      {platforms.length > 0 && (
        <span className="platform-types">
          {platforms.map((type) => {
            const PlatformLogo = platformTypeMap[type];
            return <PlatformLogo key={type} />;
          })}
        </span>
      )}
      {platforms.length === 0 && game?.platform && (
        <span className="platform-types">{String(game.platform)}</span>
      )}
    </span>
  );
};

const SearchTextField: FC<TextFieldProps> = (props) => {
  const fieldRef = useRef<any>();
  const focusableRef = useRef<any>();

  const focusTextField = () => {
    const input = fieldRef.current?.m_elInput;
    input?.focus();
    input?.click();
  };

  // Activate <Focusable /> when pressing back on text box
  useEffect(() => {
    if (!fieldRef.current) return;
    const onCancel = (evt: GamepadEvent) => {
      evt.stopPropagation(); // stop bubbling or else modal will close
      focusableRef.current?.focus();
    };

    const input = fieldRef.current?.m_elInput;
    input.addEventListener('vgp_oncancel', onCancel);
    input.addEventListener('vgp_onok', onCancel);
    return () => {
      input.removeEventListener('vgp_oncancel', onCancel);
      input.removeEventListener('vgp_onok', onCancel);
    };
  }, [fieldRef]);

  return (
    <Field
      bottomSeparator="thick"
      icon={<SearchIcon />}
      label={t('LABEL_GAME_SEARCH_TITLE', 'Search for a Game...')}
      childrenLayout="below"
    >
      <Focusable ref={focusableRef} onActivate={focusTextField} noFocusRing>
        <TextField
        // @ts-ignore: ref hack to get underlying <input>
          ref={fieldRef}
          focusOnMount={false}
          spellcheck="false"
          {...props}
        />
      </Focusable>
    </Field>
  );
};

const GameSelectionModal: FC<{
  closeModal?: () => void,
  onSelect: (game: any) => void,
  searchGames: (term: string) => Promise<any[]>,
  defaultTerm: string,
}> = ({ closeModal, onSelect, searchGames, defaultTerm }) => {
  const [value, setValue] = useState(defaultTerm);
  const [games, setGames] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const handleGameSelect = (game: any) => {
    onSelect?.(game);
    closeModal?.();
  };

  const handleSearch = useMemo(() => debounce(async (term) => {
    if (!term) {
      setLoading(false);
      return;
    }
    const resp = await searchGames(term);
    setGames(resp);
    setLoading(false);
  }, 600), [searchGames]);

  useEffect(() => {
    setLoading(true);
    handleSearch(value);
  }, [handleSearch, value]);

  return (
    <ModalRoot className="sgdb-modal sgdb-modal-gameselect" closeModal={closeModal}>
      <DialogBody>
        <DialogControlsSection>
          <SearchTextField
            value={value}
            onChange={(evt) => {
              setValue(evt.target.value);
            }}
          />
          {loading && (
            <div className="spinner">
              <Spinner />
            </div>
          )}
          {!loading && games.map((game: any) => (
            <Field
              key={game.id}
              bottomSeparator="none"
              icon={null}
              label={null}
              childrenLayout="below"
              inlineWrap="keep-inline"
              spacingBetweenLabelAndChild="none"
              childrenContainerWidth="max"
            >
              <DialogButton onClick={() => handleGameSelect(game)}>
                <GameLabel game={game} />
              </DialogButton>
            </Field>
          ))}
        </DialogControlsSection>
      </DialogBody>
    </ModalRoot>
  );
};

export default GameSelectionModal;
