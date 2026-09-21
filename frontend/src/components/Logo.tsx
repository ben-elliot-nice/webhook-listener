import logoOnBlack from '../assets/nice-labs-on-black.png'
import logoOnWhite from '../assets/nice-labs-on-white.png'

type LogoProps = {
  className?: string
}

export function Logo({ className = 'h-6' }: LogoProps) {
  return (
    <>
      <img src={logoOnWhite} alt="NiCE Labs" className={`${className} w-auto dark:hidden`} />
      <img src={logoOnBlack} alt="NiCE Labs" className={`${className} hidden w-auto dark:block`} />
    </>
  )
}
